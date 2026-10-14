import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { decryptGeminiBlob, GeminiDesktopReader, geminiProtoFields, parseGeminiKeyStore } from '../lib/gemini-desktop-reader.mjs';
import { Watcher } from '../lib/watcher.mjs';

const key = randomBytes(32);
const keys = new Map([['2:1', key]]);
function vi(number) {
  let value = BigInt(number); const bytes = [];
  do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function proto(...fields) {
  return Buffer.concat(fields.map(([number, value]) => {
    if (typeof value === 'number') return Buffer.concat([vi(number * 8), vi(value)]);
    const body = Buffer.from(value); return Buffer.concat([vi(number * 8 + 2), vi(body.length), body]);
  }));
}
function encrypted(plain) {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const preamble = proto([1, 2], [2, 1], [3, 1], [4, nonce], [5, body.length]);
  const length = Buffer.alloc(4); length.writeUInt32LE(preamble.length);
  return Buffer.concat([Buffer.from('2ebafeca2ebafeca', 'hex'), length, preamble, body]);
}
const html = '<!doctype html><html><title>Simulator</title><body>initial</body></html>';
const message = (body, identity = 'im_example') => proto([3, 'ordinary chat'], [19, proto([1, proto([42, proto([1, body], [4, proto([1, identity])])])])]);
const tree = (...nodes) => proto([19, proto(...nodes.map((node) => [1, node]))]);
const documentCard = (name, id = 'document1', mime = 'application/vnd.google-apps.document') => proto([24, proto([1, proto([157, proto([2, name], [5, mime], [3, proto([2, proto([2, 'https://docs.google.com/document/d/' + id + '/edit'])])])])])]);
let dir; let cache; let output; let db; let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gemini-app-reader-')); cache = join(dir, 'Gemini'); output = join(dir, 'outputs');
  mkdirSync(join(cache, 'user1'), { recursive: true }); db = new Database(join(cache, 'user1', 'ChatInfo2.store'));
  db.exec('CREATE TABLE ZCHATINFOSTOREDMODEL (ZCHATUUID TEXT, ZENCRYPTEDPROTOBYTES BLOB); CREATE TABLE ZCHATMESSAGESTOREDMODEL (Z_PK INTEGER PRIMARY KEY, ZCHATUUID TEXT, ZMESSAGEUUID TEXT, ZISUSERTURN INTEGER, ZCREATEDTIME REAL, ZENCRYPTEDPROTOBYTES BLOB)');
  db.query('INSERT INTO ZCHATINFOSTOREDMODEL VALUES (?, ?)').run('chat1', encrypted(proto([10, 'Session title'])));
  addMessage(1, message(html)); store = new CatalogStore(join(dir, 'catalog.db'));
});
afterEach(() => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
function addMessage(id, plain, user = 0, at = 100) { db.query('INSERT INTO ZCHATMESSAGESTOREDMODEL VALUES (?, ?, ?, ?, ?, ?)').run(id, 'chat1', 'message' + id, user, at, encrypted(plain)); }
const reader = (loadKeys = async () => keys) => new GeminiDesktopReader({ cacheRoot: cache, outputDir: output, loadKeys });

test('decrypts authenticated containers and reads the user-data key store', () => {
  const encoded = encrypted(proto([3, 'hello']));
  expect(decryptGeminiBlob(encoded, keys)).toEqual(proto([3, 'hello']));
  const keyStore = proto([1, 0xdeadbeee], [2, proto([1, 2], [2, 1], [4, key])]);
  expect(parseGeminiKeyStore(keyStore).get('2:1')).toEqual(key);
  encoded[encoded.length - 1] ^= 1;
  expect(() => decryptGeminiBlob(encoded, keys)).toThrow();
  expect(() => decryptGeminiBlob(encrypted(proto([3, 'hello'])), new Map())).toThrow();
  expect(() => geminiProtoFields(Buffer.from([10, 10, 1]))).toThrow();
});

test('indexes HTML with Gemini origin, caches keys and decrypts changed rows only', async () => {
  let calls = 0; const app = reader(async () => { calls++; return keys; });
  const first = await app.sweep(store);
  expect(first.inserted).toBe(1); expect(first.decrypted).toBe(2);
  expect(readFileSync(join(output, readdirSync(output)[0]), 'utf8')).toBe(html);
  expect(store.db.query('SELECT collector, provider, session_ref, session_title, is_deliverable, occurred_at FROM artifact_origins').get()).toEqual({ collector: 'gemini', provider: 'gemini', session_ref: 'gemini-app:user1:chat1', session_title: 'Session title', is_deliverable: 1, occurred_at: 978307300 });
  expect((await app.sweep(store)).decrypted).toBe(0); expect(calls).toBe(1);
  const changed = html.replace('initial', 'changed');
  db.query('UPDATE ZCHATMESSAGESTOREDMODEL SET ZENCRYPTEDPROTOBYTES = ? WHERE Z_PK = 1').run(encrypted(message(changed)));
  const next = await app.sweep(store); expect(next.updated).toBe(1); expect(next.decrypted).toBe(1);
  expect(store.counts().artifacts).toBe(1);
});

test('uses the newest version and does not turn input attachments or chat into artifacts', async () => {
  addMessage(2, message(html.replace('initial', 'newer')), 0, 200);
  addMessage(3, message(html, 'im_user_input'), 1, 300);
  addMessage(4, proto([3, '# Markdown response\n```go\npackage main\n```']), 0, 400);
  const result = await reader().sweep(store); expect(result.inserted).toBe(1);
  expect(readFileSync(join(output, readdirSync(output)[0]), 'utf8')).toContain('newer');
});

test('reindexes an existing copy into a fresh catalog and restores missing artifacts', async () => {
  const app = reader(); await app.sweep(store);
  const fresh = new CatalogStore(join(dir, 'fresh.db'));
  try { expect((await app.sweep(fresh)).inserted).toBe(1); } finally { fresh.close(); }
  store.db.exec('UPDATE artifacts SET missing_at = 1');
  await app.sweep(store); expect(store.db.query('SELECT missing_at FROM artifacts').get().missing_at).toBeNull();
});

test('reports Keychain failure without repeated prompts or output files', async () => {
  let calls = 0; const app = reader(async () => { calls++; throw new Error('sensitive keychain output'); });
  expect((await app.sweep(store)).code).toBe('key_unavailable');
  expect((await app.sweep(store)).code).toBe('key_unavailable');
  expect(calls).toBe(1); expect(existsSync(output)).toBe(false);
  expect(store.getState('gemini.app.last_sweep_code')).toBe('key_unavailable');
});

test('reports corrupted ciphertext and does not publish its contents', async () => {
  const broken = encrypted(message(html)); broken[broken.length - 1] ^= 1;
  db.query('UPDATE ZCHATMESSAGESTOREDMODEL SET ZENCRYPTEDPROTOBYTES = ?').run(broken);
  const result = await reader().sweep(store); expect(result.code).toBe('entry_invalid'); expect(result.inserted).toBe(0); expect(existsSync(output)).toBe(false);
});

test('does not query Keychain when the cache is absent or session collection is disabled', async () => {
  let calls = 0;
  const absent = new GeminiDesktopReader({ cacheRoot: join(dir, 'absent'), loadKeys: async () => { calls++; return keys; } });
  expect((await absent.sweep(store)).available).toBe(false); expect(calls).toBe(0);
  const watcher = new Watcher(store, [], { home: dir, withSessionLogs: false, useFsWatch: false });
  watcher.geminiDesktopReader = { sweep: async () => { calls++; } };
  await watcher.collect(); expect(calls).toBe(0);
});

test('periodic collection indexes Gemini HTML in an isolated home', async () => {
  const geminiReader = { roots: [], brainRoots: [], availableRoots: () => [], scan: async () => ({ available: false, records: [], stats: { errors: 0 } }) };
  const watcher = new Watcher(store, [], { home: dir, withSessionLogs: true, useFsWatch: false, sessionLogSources: [], geminiReader, claudeReader: { sweep: async () => ({}) } });
  watcher.cursorReader = { available: () => false };
  watcher.geminiDesktopReader = reader();
  const result = await watcher.collect();
  expect(result.find((entry) => entry.geminiApp)?.geminiApp.inserted).toBe(1);
  expect(store.counts().artifacts).toBe(1);
});

test('rejects oversized encrypted rows without writes', async () => {
  db.query('UPDATE ZCHATMESSAGESTOREDMODEL SET ZENCRYPTEDPROTOBYTES = ?').run(Buffer.alloc(4 * 1024 * 1024 + 1));
  const result = await reader().sweep(store);
  expect(result.code).toBe('entry_invalid'); expect(result.inserted).toBe(0); expect(existsSync(output)).toBe(false);
});

test('collects standalone Markdown document content without copying ordinary chat', async () => {
  addMessage(2, proto([20, proto([2, 'artifact-md'], [4, 'Research'], [9, proto([1, 'artifact-md'], [2, 'Research'], [15, proto([1, '# Research\nOriginal report'])])])]), 0, 200);
  const result = await reader().sweep(store); expect(result.inserted).toBe(2);
  const markdown = readdirSync(output).find((name) => name.endsWith('.md'));
  expect(readFileSync(join(output, markdown), 'utf8')).toBe('# Research\nOriginal report');
});

test.each([
  ['pdf', 'application/pdf', Buffer.from('%PDF-1.7\nfixture\n%%EOF')],
  ['png', 'image/png', Buffer.from('89504e470d0a1a0a00000000', 'hex')],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('504b030400000000', 'hex')],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from('504b030400000000', 'hex')],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', Buffer.from('504b030400000000', 'hex')],
])('collects generated %s bytes from file attachments', async (extension, mime, body) => {
  const attachment = proto([3, 'result.' + extension], [9, 2], [12, mime], [26, body]);
  addMessage(2, tree(proto([35, proto([1, attachment])])), 0, 200);
  const result = await reader().sweep(store); expect(result.inserted).toBe(2);
  const file = readdirSync(output).find((name) => name.endsWith('.' + extension));
  expect(readFileSync(join(output, file))).toEqual(body);
});

test('downloads generated image outputs, excludes input images and search icons', async () => {
  const image = proto([2, 'https://lh3.googleusercontent.com/gg/generated'], [7, 'image1']);
  addMessage(2, tree(proto([21, proto([1, image])])), 0, 200);
  addMessage(3, tree(proto([21, proto([1, image])])), 1, 300);
  addMessage(4, tree(proto([2, proto([1, proto([1, 'https://lh3.googleusercontent.com/search-icon'])])])), 0, 400);
  let calls = 0;
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const app = new GeminiDesktopReader({ cacheRoot: cache, outputDir: output, loadKeys: async () => keys, loadRemote: async (reference) => { calls++; expect(reference.image).toBe(true); return { body: png, extension: 'png' }; } });
  expect((await app.sweep(store)).inserted).toBe(2); expect(calls).toBe(1);
  expect((await app.sweep(store)).unchanged).toBe(2); expect(calls).toBe(1);
});

test('downloads Google Docs as actual Markdown and reuses copies for fresh catalogs', async () => {
  addMessage(2, tree(documentCard('Created report.md')), 0, 200);
  let calls = 0;
  const app = new GeminiDesktopReader({ cacheRoot: cache, outputDir: output, loadKeys: async () => keys, loadRemote: async (reference) => { calls++; expect(reference.driveId).toBe('document1'); return { body: Buffer.from('# Created report\nBody'), extension: 'md', revision: 'revision1' }; } });
  expect((await app.sweep(store)).inserted).toBe(2);
  expect((await app.sweep(store)).unchanged).toBe(2); expect(calls).toBe(1);
  const fresh = new CatalogStore(join(dir, 'fresh.db'));
  try { expect((await app.sweep(fresh)).inserted).toBe(2); expect(calls).toBe(1); } finally { fresh.close(); }
  const artifact = (await app.artifacts()).artifacts.find((item) => item.remote);
  app.remoteCache.get(artifact.identity).retryAt = 0;
  app.loadRemote = async (reference, previous) => { expect(previous.revision).toBe('revision1'); return { unchanged: true, extension: 'md', revision: 'revision1' }; };
  expect((await app.sweep(store)).unchanged).toBe(2);
});

test('collects images explicitly marked as code-generated outputs', async () => {
  addMessage(2, tree(proto([2, proto([1, proto([1, 'https://lh3.googleusercontent.com/chart'], [7, 2])])])), 0, 200);
  const app = new GeminiDesktopReader({ cacheRoot: cache, outputDir: output, loadKeys: async () => keys, loadRemote: async () => ({ body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Chart</text></svg>'), extension: 'svg' }) });
  expect((await app.sweep(store)).inserted).toBe(2);
  expect(readdirSync(output).some((name) => name.endsWith('.svg'))).toBe(true);
});

test('reports remote errors, keeps HTML and does not save links as document contents', async () => {
  addMessage(2, tree(documentCard('Unavailable.md')), 0, 200);
  let calls = 0;
  const app = new GeminiDesktopReader({ cacheRoot: cache, outputDir: output, loadKeys: async () => keys, loadRemote: async () => { calls++; throw new Error('CANARY_SIGNED_URL_TOKEN'); } });
  const result = await app.sweep(store);
  expect(result.code).toBe('remote_unavailable'); expect(result.remoteFailed).toBe(1); expect(result.inserted).toBe(1);
  await app.sweep(store); expect(calls).toBe(1);
  expect(readdirSync(output).filter((name) => name.endsWith('.md'))).toEqual([]);
  expect(JSON.stringify(store.recentIngestEvents())).not.toContain('CANARY_SIGNED_URL_TOKEN');
});

test('bounds remote work and eventually processes every output', async () => {
  addMessage(2, tree(...Array.from({ length: 5 }, (_, index) => documentCard('Report.md', 'document' + index))), 0, 200);
  let calls = 0;
  const app = new GeminiDesktopReader({ cacheRoot: cache, outputDir: output, loadKeys: async () => keys, loadRemote: async () => { calls++; return { body: Buffer.from('# Report'), extension: 'md' }; } });
  expect((await app.sweep(store)).deferred).toBe(3); expect(calls).toBe(2);
  await app.sweep(store); await app.sweep(store);
  expect(calls).toBe(5); expect(store.counts().artifacts).toBe(6);
  expect([...app.remoteCache.values()].every((item) => !item.body)).toBe(true);
});
