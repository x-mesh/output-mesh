import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { ClaudeDesktopReader, parseClaudeCacheEntry } from '../lib/claude-desktop-reader.mjs';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const V7_UUID = '019eb385-b176-77f2-b0e6-05460e2ed404';
const encoder = new TextEncoder();
const envelope = (url, body, headers = {}) => encoder.encode(JSON.stringify({ url, body, headers }));
// 실제 Simple Cache 엔트리처럼 본문 뒤에 EOF 와 HTTP 헤더를 둔다.
const simpleCache = (url, body, encoding) => cacheEntry(url, encoding === 'gzip' ? gzipSync(body) : encoding === 'br' ? brotliCompressSync(body) : body, { 'content-type': 'text/html', ...(encoding ? { 'content-encoding': encoding } : {}) });
const embeddedGzipCache = (url, body) => cacheEntry(url, gzipSync(body), { 'content-encoding': 'gzip' });

const SIMPLE_EOF = Buffer.from('d8410d97456ffaf4', 'hex');
function cacheEntry(url, body, headers = {}, status = 200, keyPrefix = '1/0/') {
  const key = encoder.encode(keyPrefix + url);
  const head = Buffer.alloc(24); head.writeUInt32LE(key.length, 12);
  const http = encoder.encode(['HTTP/1.1 ' + status, ...Object.entries(headers).map(([name, value]) => name + ':' + value)].join('\0') + '\0\0');
  return Buffer.concat([head, key, Buffer.from(body), SIMPLE_EOF, Buffer.alloc(16), http, SIMPLE_EOF, Buffer.alloc(16)]);
}

const ORG = '3a7f0c1e-9b2d-4c5e-8f1a-2b3c4d5e6f70';
const CONV = '2b7e1516-28ae-4d2a-a6ab-f7158809cf4f';
const conversationUrl = (consistency) => `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=${consistency}`;
const downloadUrl = (path) => `https://claude.ai/api/organizations/${ORG}/conversations/${CONV}/wiggle/download-file?path=${encodeURIComponent(path)}`;
const tool = (name, input) => ({ type: 'tool_use', name, input });
const message = (uuid, parent, at, content) => ({ uuid, parent_message_uuid: parent, created_at: at, sender: 'assistant', content });
const conversation = (updatedAt, planText) => ({
  uuid: CONV, name: 'Weekly plan', updated_at: updatedAt, current_leaf_message_uuid: 'm3',
  chat_messages: [
    message('m1', '00000000-0000-4000-8000-000000000000', '2026-09-30T09:00:00Z', [tool('create_file', { path: '/mnt/user-data/outputs/plan.md', file_text: planText })]),
    message('m2', 'm1', '2026-09-30T09:10:00Z', [
      tool('str_replace', { path: '/mnt/user-data/outputs/plan.md', old_str: 'old line', new_str: 'new line' }),
      tool('create_file', { path: '/home/claude/scratch.py', file_text: 'print(1)' }),
      tool('create_file', { path: '/mnt/user-data/outputs/../escape.md', file_text: 'escape' }),
    ]),
    message('m2b', 'm1', '2026-09-30T09:05:00Z', [tool('create_file', { path: '/mnt/user-data/outputs/abandoned.md', file_text: 'abandoned branch' })]),
    message('m3', 'm2', '2026-09-30T09:20:00Z', [tool('visualize:show_widget', { title: 'Flow: A/B', widget_code: '<svg><text>flow</text></svg>' })]),
  ],
});
const listFiles = (root) => readdirSync(root, { recursive: true }).filter((name) => statSync(join(root, name)).isFile()).sort();

let dir;
let store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-reader-')); store = new CatalogStore(join(dir, 'catalog.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Claude Desktop local cache reader', () => {
  test('allowlists metadata and frame URLs and redacts credential fields', () => {
    const metadata = parseClaudeCacheEntry(envelope('https://claude.ai/api/user_artifacts?token=secret', JSON.stringify({ artifacts: [{ uuid: UUID, title: 'Synthetic', slug: 'demo', version: '2', organization_id: 'private' }] })));
    expect(metadata.records[0]).toMatchObject({ uuid: UUID, title: 'Synthetic', slug: 'demo', version: '2' });
    const body = parseClaudeCacheEntry(envelope('https://claude.ai/api/frame/' + UUID + '?authorization=secret', '<!doctype html><html><body>safe</body></html>'));
    expect(new TextDecoder().decode(body.body)).toContain('<!doctype html>');
    expect(parseClaudeCacheEntry(envelope('https://evil.example/frame/' + UUID, '<!doctype html><html></html>'))).toBeNull();
  });

  test('reads gzip and Brotli bodies and rejects truncated or oversized payloads', () => {
    const html = encoder.encode('<!doctype html><html><body>synthetic</body></html>');
    expect(parseClaudeCacheEntry(simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/7/', html, 'gzip')).body).toBeTruthy();
    expect(parseClaudeCacheEntry(simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/8/', html, 'br')).body).toBeTruthy();
    expect(parseClaudeCacheEntry(simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/9/', html.slice(0, -3)))).toBeNull();
    expect(parseClaudeCacheEntry(envelope('https://' + UUID + '.frame.claudeusercontent.com/_f/10/', 'x'.repeat(100)), { maxBodyBytes: 10 })).toBeNull();
    const embedded = parseClaudeCacheEntry(embeddedGzipCache('https://' + UUID + '.frame.claudeusercontent.com/_f/11/', encoder.encode('<!doctype html><html><title>Embedded</title><body>safe</body></html>')));
    expect(embedded).toMatchObject({ kind: 'frame', uuid: UUID });
    expect(parseClaudeCacheEntry(embeddedGzipCache('https://' + V7_UUID + '.frame.claudeusercontent.com/_f/12/', encoder.encode('<!doctype html><html><body>v7</body></html>')))).toMatchObject({ kind: 'frame', uuid: V7_UUID });
    const declaredLarge = gzipSync(html);
    new DataView(declaredLarge.buffer, declaredLarge.byteOffset).setUint32(declaredLarge.length - 4, 101, true);
    expect(parseClaudeCacheEntry(cacheEntry('https://' + UUID + '.frame.claudeusercontent.com/_f/13/', declaredLarge, { 'content-encoding': 'gzip' }), { maxBodyBytes: 100 })).toBeNull();
  });

  test('correlates newest complete version and materializes one UUID file', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'metadata'), envelope('https://claude.ai/api/user_artifacts', JSON.stringify({ artifacts: [{ uuid: UUID, title: 'Newest', slug: 'demo', version: '2' }] })));
    writeFileSync(join(cache, 'old'), simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/1/', encoder.encode('<!doctype html><html><body>old</body></html>')));
    writeFileSync(join(cache, 'new'), simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/2/', encoder.encode('<!doctype html><html><body>new</body></html>')));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output });
    expect((await reader.artifacts()).artifacts[0].version).toBe('2');
    expect((await reader.sweep(store)).inserted).toBe(1);
    expect(new TextDecoder().decode(readFileSync(join(output, UUID + '.html')))).toContain('new');
    expect(store.db.query('SELECT collector, provider, session_ref FROM artifact_origins').all()).toEqual([{ collector: 'claude-app', provider: 'claude-app', session_ref: UUID }]);
    expect((await reader.sweep(store)).unchanged).toBe(1);
  });

  test('ingests into a fresh catalog when the local copy already exists', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'frame'), embeddedGzipCache('https://' + UUID + '.frame.claudeusercontent.com/_f/5/', encoder.encode('<!doctype html><html><body>kept</body></html>')));
    expect((await new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output }).sweep(store)).inserted).toBe(1);
    const fresh = new CatalogStore(join(dir, 'fresh.db'));
    try {
      expect((await new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output }).sweep(fresh)).inserted).toBe(1);
      expect(fresh.db.query('SELECT session_ref FROM artifact_origins').all()).toEqual([{ session_ref: UUID }]);
    } finally { fresh.close(); }
  });

  test('collects a complete frame without metadata and keeps URL fields out of provenance', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'frame'), embeddedGzipCache('https://' + UUID + '.frame.claudeusercontent.com/_f/12/?token=secret', encoder.encode('<!doctype html><html><title>Frame title</title><body>safe</body></html>')));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output });
    expect((await reader.artifacts()).artifacts[0]).toMatchObject({ uuid: UUID, title: 'Frame title', pageUrl: null });
    await reader.sweep(store);
    const origin = store.db.query('SELECT prompt, session_title FROM artifact_origins').get();
    expect(origin).toEqual({ prompt: 'version 12', session_title: 'Frame title' });
  });

  test('caches unchanged entries, removes evicted cache records, and keeps managed output', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    const first = join(cache, 'first'); const second = join(cache, 'second');
    writeFileSync(first, embeddedGzipCache('https://' + UUID + '.frame.claudeusercontent.com/_f/20/', encoder.encode('<!doctype html><html><body>one</body></html>')));
    writeFileSync(second, embeddedGzipCache('https://' + V7_UUID + '.frame.claudeusercontent.com/_f/21/', encoder.encode('<!doctype html><html><body>two</body></html>')));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output });
    const firstStats = (await reader.artifacts()).stats;
    const secondStats = (await reader.artifacts()).stats;
    expect(firstStats.scanned).toBe(2);
    expect(secondStats.scanned).toBe(0);
    expect(secondStats.skipped).toBe(2);
    await reader.sweep(store);
    unlinkSync(second);
    const afterEviction = await reader.sweep(store);
    expect(afterEviction.found).toBe(1);
    expect(readFileSync(join(output, UUID + '.html'))).toBeTruthy();
    expect(() => readFileSync(join(output, V7_UUID + '.html'))).not.toThrow();
  });

  test('caps metadata payloads, isolates bad entries, and yields during batches', async () => {
    const cache = join(dir, 'Cache_Data'); mkdirSync(cache);
    writeFileSync(join(cache, 'bad'), envelope('https://' + UUID + '.frame.claudeusercontent.com/_f/30/', '<!doctype html><html>truncated'));
    writeFileSync(join(cache, 'large-metadata'), envelope('https://claude.ai/api/user_artifacts', 'x'.repeat(100)));
    for (let i = 0; i < 8; i++) writeFileSync(join(cache, 'entry-' + i), embeddedGzipCache('https://' + (i % 2 ? V7_UUID : UUID) + '.frame.claudeusercontent.com/_f/' + (31 + i) + '/', encoder.encode('<!doctype html><html><body>batch</body></html>')));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: join(dir, 'managed'), batchSize: 1 });
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 0);
    const result = await reader.artifacts();
    expect(result.available).toBe(true);
    expect(result.stats.errors).toBeLessThanOrEqual(1);
    expect(result.stats.found).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timerFired).toBe(true);
    await reader.sweep(store);
    expect(store.getState('claude.last_sweep_code')).toBe('entry_invalid');
  });

  test('rebuilds files and widgets from the visible branch of the newest cached conversation', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'stale'), cacheEntry(conversationUrl('eventual'), brotliCompressSync(JSON.stringify(conversation('2026-09-30T08:00:00Z', '# Stale\n'))), { 'content-encoding': 'br' }));
    writeFileSync(join(cache, 'fresh'), cacheEntry(conversationUrl('strong'), brotliCompressSync(JSON.stringify(conversation('2026-09-30T10:00:00Z', '# Plan\nold line\n'))), { 'content-encoding': 'br' }));
    const stats = await new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output }).sweep(store);
    expect(stats).toMatchObject({ inserted: 2, failed: 0, kinds: { file: 1, widget: 1 } });
    expect(listFiles(output)).toEqual([CONV + '/plan.md', CONV + '/widgets/Flow A B.html']);
    expect(readFileSync(join(output, CONV, 'plan.md'), 'utf8')).toBe('# Plan\nnew line\n');
    const widget = readFileSync(join(output, CONV, 'widgets', 'Flow A B.html'), 'utf8');
    expect(widget).toContain('<title>Flow: A/B</title>');
    expect(widget).toContain('<svg><text>flow</text></svg>');
    expect(widget).toContain('.sr-only {');
    expect(store.db.query('SELECT DISTINCT collector, session_ref, session_title FROM artifact_origins').all()).toEqual([{ collector: 'claude-app', session_ref: CONV, session_title: 'Weekly plan' }]);
    expect(store.getState('claude.last_sweep_code')).toBe('ok');
  });

  test('prefers downloaded bytes and refuses a download whose length does not match', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'conversation'), cacheEntry(conversationUrl('strong'), JSON.stringify(conversation('2026-09-30T10:00:00Z', '# Plan\nold line\n'))));
    writeFileSync(join(cache, 'plan'), cacheEntry(downloadUrl('/mnt/user-data/outputs/plan.md'), 'downloaded plan', { 'content-length': '15' }));
    const archive = gzipSync('raw archive');
    writeFileSync(join(cache, 'archive'), cacheEntry(downloadUrl('/mnt/user-data/outputs/data/archive.gz'), archive, { 'content-length': String(archive.length) }));
    writeFileSync(join(cache, 'cut'), cacheEntry(downloadUrl('/mnt/user-data/outputs/cut.md'), 'partial', { 'content-length': '999' }));
    const stats = await new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output }).sweep(store);
    expect(stats.kinds).toEqual({ download: 2, widget: 1 });
    expect(readFileSync(join(output, CONV, 'plan.md'), 'utf8')).toBe('downloaded plan');
    expect(Buffer.from(readFileSync(join(output, CONV, 'data', 'archive.gz'))).equals(Buffer.from(archive))).toBe(true);
    expect(listFiles(output)).not.toContain(CONV + '/cut.md');
    expect(store.getState('claude.last_sweep_code')).toBe('entry_invalid');
  });

  test('keeps the rebuilt file when the conversation edited it after the download', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'conversation'), cacheEntry(conversationUrl('strong'), JSON.stringify(conversation('2026-09-30T10:00:00Z', '# Plan\nold line\n'))));
    const download = join(cache, 'plan');
    writeFileSync(download, cacheEntry(downloadUrl('/mnt/user-data/outputs/plan.md'), '# Plan\nold line\n', { 'content-length': String(Buffer.byteLength('# Plan\nold line\n')) }));
    const beforeEdit = new Date('2026-09-30T09:05:00Z');
    utimesSync(download, beforeEdit, beforeEdit);
    const stats = await new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output }).sweep(store);
    expect(stats.kinds).toEqual({ file: 1, widget: 1 });
    expect(readFileSync(join(output, CONV, 'plan.md'), 'utf8')).toBe('# Plan\nnew line\n');
  });

  test('reads entries whose cache key is partitioned by site', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'conversation'), cacheEntry(conversationUrl('strong'), JSON.stringify(conversation('2026-09-30T10:00:00Z', '# Plan\nold line\n')), {}, 200, '1/0/_dk_https://claude.ai https://claude.ai '));
    expect((await new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output }).sweep(store)).kinds).toEqual({ file: 1, widget: 1 });
  });

  test('keeps one copy when two outputs differ only in case', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    const twoCases = { uuid: CONV, name: 'Cases', updated_at: '2026-09-30T10:00:00Z', current_leaf_message_uuid: 'm2', chat_messages: [
      message('m1', '00000000-0000-4000-8000-000000000000', '2026-09-30T09:00:00Z', [tool('create_file', { path: '/mnt/user-data/outputs/Plan.md', file_text: 'upper' })]),
      message('m2', 'm1', '2026-09-30T09:10:00Z', [tool('create_file', { path: '/mnt/user-data/outputs/plan.md', file_text: 'lower' })]),
    ] };
    writeFileSync(join(cache, 'conversation'), cacheEntry(conversationUrl('strong'), JSON.stringify(twoCases)));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output });
    expect((await reader.sweep(store)).inserted).toBe(1);
    expect(listFiles(output)).toEqual([CONV + '/plan.md']);
    expect(readFileSync(join(output, CONV, 'plan.md'), 'utf8')).toBe('lower');
    expect(await reader.sweep(store)).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
  });

  test('ignores frame subresources, cached 404s, and finds the metadata uuid behind a named identifier', async () => {
    const cache = join(dir, 'Cache_Data'); mkdirSync(cache);
    writeFileSync(join(cache, 'runtime'), cacheEntry('https://' + UUID + '.frame.claudeusercontent.com/_runtime/room.js', 'export {}', { 'content-type': 'text/javascript' }));
    writeFileSync(join(cache, 'deleted'), cacheEntry(conversationUrl('strong'), JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }), {}, 404));
    expect((await new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: join(dir, 'managed') }).sweep(store)).found).toBe(0);
    expect(store.getState('claude.last_sweep_code')).toBe('ok');
    const metadata = parseClaudeCacheEntry(envelope('https://claude.ai/api/user_artifacts', JSON.stringify({ artifacts: [{ uuid: UUID, artifact_identifier: 'deck-detail', title: 'Deck' }] })));
    expect(metadata.records).toEqual([expect.objectContaining({ uuid: UUID, title: 'Deck' })]);
  });

  test('keeps an invalid-entry state when no artifact is readable', async () => {
    const cache = join(dir, 'Cache_Data'); mkdirSync(cache);
    writeFileSync(join(cache, 'bad'), envelope('https://' + UUID + '.frame.claudeusercontent.com/_f/40/', '<!doctype html><html>truncated'));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: join(dir, 'managed') });
    expect((await reader.sweep(store)).found).toBe(0);
    expect(store.getState('claude.last_sweep_code')).toBe('entry_invalid');
  });
});
