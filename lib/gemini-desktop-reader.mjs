import { Database } from 'bun:sqlite';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { geminiDownloadUrl, geminiDriveId, geminiFileExtension, loadGeminiRemote, validateGeminiFile } from './gemini-downloads.mjs';

const execute = promisify(execFile);
const MAGIC = Buffer.from('2ebafeca2ebafeca', 'hex');
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 10_000;
const CORE_DATA_EPOCH = 978307200;
const MAX_REMOTE_DOWNLOADS = 2;
const REMOTE_CHECK_MS = 300_000;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clean = (value) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);

function varint(bytes, start) {
  let value = 0n;
  let offset = start;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (offset >= bytes.length) throw new Error('Truncated Gemini protobuf.');
    const byte = bytes[offset++];
    value |= BigInt(byte & 127) << shift;
    if (byte < 128) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Gemini protobuf integer exceeds supported range.');
      return { value: Number(value), offset };
    }
  }
  throw new Error('Invalid Gemini protobuf integer.');
}

export function geminiProtoFields(input) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = varint(bytes, offset); offset = tag.offset;
    const number = Math.floor(tag.value / 8); const wire = tag.value % 8;
    if (!number) throw new Error('Invalid Gemini protobuf field.');
    let value;
    if (wire === 0) { const decoded = varint(bytes, offset); value = decoded.value; offset = decoded.offset; }
    else if ([1, 2, 5].includes(wire)) {
      let size = wire === 1 ? 8 : 4;
      if (wire === 2) { const decoded = varint(bytes, offset); size = decoded.value; offset = decoded.offset; }
      if (size > bytes.length - offset) throw new Error('Truncated Gemini protobuf field.');
      value = bytes.subarray(offset, offset + size); offset += size;
    } else throw new Error('Unsupported Gemini protobuf wire type.');
    fields.push({ number, value });
  }
  return fields;
}

const field = (fields, number) => fields.find((item) => item.number === number)?.value;
function text(fields, number) {
  const value = field(fields, number);
  return Buffer.isBuffer(value) ? new TextDecoder('utf-8', { fatal: true }).decode(value) : '';
}
function nested(fields, number) {
  return fields.filter((item) => item.number === number).map((item) => {
    if (!Buffer.isBuffer(item.value)) throw new Error('Invalid Gemini nested field.');
    return geminiProtoFields(item.value);
  });
}

export function parseGeminiKeyStore(bytes) {
  const keys = new Map();
  for (const record of nested(geminiProtoFields(bytes), 2)) {
    if (field(record, 1) !== 2) continue;
    const key = field(record, 4);
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid Gemini key length.');
    keys.set(`${field(record, 1)}:${field(record, 2)}`, key);
  }
  if (!keys.size) throw new Error('Empty Gemini key store.');
  return keys;
}

export function decryptGeminiBlob(input, keys) {
  const bytes = Buffer.from(input);
  if (bytes.length < 12 || bytes.length > MAX_BLOB_BYTES || !bytes.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid Gemini container.');
  const end = 12 + bytes.readUInt32LE(8);
  if (end > bytes.length) throw new Error('Truncated Gemini preamble.');
  const preamble = geminiProtoFields(bytes.subarray(12, end));
  const nonce = field(preamble, 4); const body = bytes.subarray(end);
  if (field(preamble, 3) !== 1 || field(preamble, 5) !== body.length || body.length < 16 || !Buffer.isBuffer(nonce) || nonce.length !== 12) throw new Error('Invalid Gemini encryption format.');
  const key = keys.get(`${field(preamble, 1)}:${field(preamble, 2)}`);
  if (!key) throw new Error('Gemini key version is unavailable.');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(body.subarray(-16));
  return Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]);
}

async function keychainKeys() {
  const { stdout } = await execute('/usr/bin/security', ['find-generic-password', '-s', 'Gemini Safe Storage', '-a', 'Gemini Keys', '-w'], { timeout: 30_000, maxBuffer: 16 * 1024 });
  const encoded = stdout.trim();
  if (!/^(?:[a-f0-9]{2})+$/i.test(encoded)) throw new Error('Invalid Gemini key store encoding.');
  return parseGeminiKeyStore(Buffer.from(encoded, 'hex'));
}

function inlineFile(name, body, identity, mime = '') {
  const extension = geminiFileExtension(name, mime);
  if (!extension || !body?.length) throw new Error('Unsupported Gemini inline file.');
  return { body: validateGeminiFile(Buffer.from(body), extension), extension, name, identity: identity || name };
}

function fileAttachment(record, generated = false) {
  const source = field(record, 9);
  if (source === 1 || source === 4 || (!generated && ![2, 3].includes(source))) return null;
  const mime = text(record, 12); const name = text(record, 3);
  const extension = geminiFileExtension(name, mime);
  const inline = field(record, 26);
  if (Buffer.isBuffer(inline) && inline.length) return inlineFile(name, inline, text(record, 6) || name, mime);
  const url = nested(record, 8).map((urls) => text(urls, 2)).find(Boolean) || text(record, 4);
  if (!url) throw new Error('Gemini generated file has no download address.');
  return remoteFile(name, mime, url, text(record, 6), generated);
}

function remoteFile(name, mime, value, identity, image = false) {
  const url = geminiDownloadUrl(value);
  if (!url) throw new Error('Unsupported Gemini generated file address.');
  const driveId = geminiDriveId(url);
  const extension = geminiFileExtension(name, mime);
  if (!extension && !driveId && !image) throw new Error('Unsupported Gemini generated file type.');
  return { name, mime, extension, identity: identity || driveId || url, remote: { name, mime, url, driveId, extension, image } };
}

function parsedArtifacts(record) {
  const out = [];
  const identity = text(record, 2); const title = text(record, 4);
  for (const content of nested(record, 9)) {
    const id = text(content, 1) || identity;
    const name = text(content, 2) || title;
    for (const doc of nested(content, 15)) out.push(inlineFile(name.endsWith('.md') ? name : name + '.md', Buffer.from(text(doc, 1)), id));
    for (const file of nested(content, 34)) out.push(inlineFile(text(file, 1), Buffer.from(text(file, 3)), id));
  }
  if (!out.length && ['md', 'markdown', 'txt', 'html', 'svg'].includes(geminiFileExtension(title))) {
    const body = text(record, 3);
    if (body) out.push(inlineFile(title, Buffer.from(body), identity));
  }
  return out;
}

function outputArtifacts(plain) {
  const out = [];
  const message = geminiProtoFields(plain);
  for (const number of [20, 38]) for (const parsed of nested(message, number)) out.push(...parsedArtifacts(parsed));
  // 이 앱 버전의 산출물 경로만 읽어 일반 채팅을 파일로 오인하지 않는다.
  for (const content of nested(message, 19)) {
    for (const node of nested(content, 1)) {
      for (const artifact of nested(node, 42)) {
        const body = text(artifact, 1);
        if (!/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(body)) throw new Error('Unsupported Gemini artifact body.');
        const identity = nested(artifact, 4).map((meta) => text(meta, 1)).find(Boolean);
        out.push({ body, identity, extension: 'html' });
      }
      for (const generation of nested(node, 21)) {
        for (const image of nested(generation, 1)) {
          if (field(image, 4) === 1 || field(image, 5) === 1) continue;
          const attachment = [...nested(image, 9), ...nested(image, 8)][0];
          if (attachment) {
            const file = fileAttachment(attachment, true); if (file) out.push(file);
          } else {
            const url = text(image, 2) || text(image, 1);
            if (url) out.push(remoteFile('', '', url, text(image, 7), true));
          }
        }
      }
      for (const images of nested(node, 2)) {
        for (const image of nested(images, 1)) {
          if (field(image, 7) !== 2) continue;
          const url = text(image, 12) || text(image, 1);
          if (url) out.push(remoteFile('', '', url, null, true));
        }
      }
      for (const block of nested(node, 35)) {
        const inspect = (record, depth = 0) => {
          if (depth > 4) throw new Error('Gemini file block exceeds nesting limit.');
          if (text(record, 12) && [2, 3].includes(field(record, 9))) { const file = fileAttachment(record); if (file) out.push(file); return; }
          for (const item of record) {
            if (!Buffer.isBuffer(item.value)) continue;
            let child; try { child = geminiProtoFields(item.value); } catch { continue; }
            inspect(child, depth + 1);
          }
        };
        inspect(block);
      }
      for (const card of nested(node, 24)) {
        for (const container of nested(card, 1)) {
          for (const document of nested(container, 157)) {
            const name = text(document, 2); const mime = text(document, 5);
            const urls = nested(document, 3).flatMap((action) => nested(action, 2).map((link) => text(link, 2)));
            const url = urls.find((value) => geminiDownloadUrl(value));
            if (url && (geminiFileExtension(name, mime) || geminiDriveId(url))) out.push(remoteFile(name, mime, url));
          }
        }
      }
    }
  }
  return out;
}

export class GeminiDesktopReader {
  constructor({ home = homedir(), cacheRoot = join(home, 'Library', 'Caches', 'com.google.GeminiMacOS', 'Gemini'), outputDir = join(home, 'Library', 'Application Support', 'AgentOutputCatalog', 'Gemini-app-artifacts'), loadKeys = keychainKeys, loadRemote = (reference, previous) => loadGeminiRemote(reference, outputDir, previous) } = {}) {
    this.cacheRoot = cacheRoot; this.outputDir = outputDir; this.loadKeys = loadKeys;
    this.keys = null; this.keyAttempted = false; this.rowCache = new Map();
    this.loadRemote = loadRemote; this.remoteCache = new Map();
    this.remoteCursor = 0;
  }

  databases() {
    if (!existsSync(this.cacheRoot)) return [];
    return readdirSync(this.cacheRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^user\d+$/.test(entry.name))
      .map((entry) => ({ account: entry.name, path: join(this.cacheRoot, entry.name, 'ChatInfo2.store') })).filter((entry) => existsSync(entry.path));
  }

  available() { return this.databases().length > 0; }

  async artifacts() {
    const databases = this.databases();
    const stats = { scanned: 0, decrypted: 0, found: 0, errors: 0 };
    if (!databases.length) return { artifacts: [], stats, available: false };
    if (databases.length > 8) return { artifacts: [], stats: { ...stats, errors: 1 }, available: true, code: 'entry_invalid' };
    if (!this.keys) {
      if (this.keyAttempted) return { artifacts: [], stats: { ...stats, errors: 1 }, available: true, code: 'key_unavailable' };
      this.keyAttempted = true;
      try { this.keys = await this.loadKeys(); }
      catch { return { artifacts: [], stats: { ...stats, errors: 1 }, available: true, code: 'key_unavailable' }; }
    }
    const artifacts = []; let scanBytes = 0; let scanRows = 0;
    for (const { account, path } of databases) {
      let db;
      try {
        db = new Database(path, { readonly: true }); db.exec('BEGIN');
        const tables = ['ZCHATINFOSTOREDMODEL', 'ZCHATMESSAGESTOREDMODEL'];
        for (const table of tables) {
          const limits = db.query(`SELECT COUNT(*) AS count, COALESCE(SUM(length(ZENCRYPTEDPROTOBYTES)), 0) AS bytes, COALESCE(MAX(length(ZENCRYPTEDPROTOBYTES)), 0) AS largest FROM ${table}`).get();
          scanBytes += limits.bytes;
          scanRows += limits.count;
          if (scanRows > MAX_ROWS || limits.largest > MAX_BLOB_BYTES || scanBytes > MAX_SCAN_BYTES) throw new Error('Gemini cache exceeds scan limits.');
        }
        const chats = new Map();
        for (const row of db.query('SELECT ZCHATUUID, ZENCRYPTEDPROTOBYTES FROM ZCHATINFOSTOREDMODEL').all()) {
          const token = digest(row.ZENCRYPTEDPROTOBYTES); const id = `${account}:chat:${row.ZCHATUUID}`;
          let cached = this.rowCache.get(id);
          if (cached?.token !== token) { cached = { token, title: clean(text(geminiProtoFields(decryptGeminiBlob(row.ZENCRYPTEDPROTOBYTES, this.keys)), 10)) }; this.rowCache.set(id, cached); stats.decrypted++; }
          chats.set(row.ZCHATUUID, cached.title);
        }
        const rows = db.query('SELECT Z_PK, ZCHATUUID, ZMESSAGEUUID, ZCREATEDTIME, ZENCRYPTEDPROTOBYTES FROM ZCHATMESSAGESTOREDMODEL WHERE ZISUSERTURN = 0 ORDER BY ZCREATEDTIME, Z_PK').all();
        for (const row of rows) {
          stats.scanned++;
          const token = digest(row.ZENCRYPTEDPROTOBYTES); const id = `${account}:message:${row.Z_PK}`;
          let cached = this.rowCache.get(id);
          if (cached?.token !== token) {
            cached = { token, artifacts: outputArtifacts(decryptGeminiBlob(row.ZENCRYPTEDPROTOBYTES, this.keys)) };
            this.rowCache.set(id, cached); stats.decrypted++;
          }
          for (const item of cached.artifacts) {
            const identity = digest(`${account}:${row.ZCHATUUID}:${item.identity || row.ZMESSAGEUUID}`);
            artifacts.push({ ...item, identity, token: item.body ? digest(item.body) : null, sessionRef: `gemini-app:${account}:${row.ZCHATUUID}`, title: chats.get(row.ZCHATUUID) || null, occurredAt: Number.isFinite(row.ZCREATEDTIME) ? Math.floor(row.ZCREATEDTIME + CORE_DATA_EPOCH) : null });
          }
        }
      } catch { stats.errors++; }
      finally { db?.close(); }
    }
    if (this.rowCache.size > MAX_ROWS) this.rowCache.clear();
    const latest = new Map();
    for (const artifact of artifacts) { const old = latest.get(artifact.identity); if (!old || (artifact.occurredAt ?? 0) >= (old.occurredAt ?? 0)) latest.set(artifact.identity, artifact); }
    stats.found = latest.size;
    return { artifacts: [...latest.values()], stats, available: true, code: stats.errors ? 'entry_invalid' : 'ok' };
  }

  async sweep(store) {
    const found = await this.artifacts();
    const stats = { ...found.stats, inserted: 0, updated: 0, unchanged: 0, failed: 0, remoteFailed: 0, remoteErrors: {}, deferred: 0, available: found.available };
    store.setState('gemini.app.last_sweep_at', Math.floor(Date.now() / 1000));
    let code = found.available ? found.code : 'unavailable';
    const collector = await import('./collector.mjs');
    let downloads = 0;
    const ordered = [...found.artifacts.slice(this.remoteCursor), ...found.artifacts.slice(0, this.remoteCursor)];
    this.remoteCursor = found.artifacts.length ? (this.remoteCursor + MAX_REMOTE_DOWNLOADS) % found.artifacts.length : 0;
    for (const artifact of ordered) {
      if (artifact.remote) {
        const referenceToken = digest(JSON.stringify(artifact.remote));
        let cached = this.remoteCache.get(artifact.identity);
        let copy;
        if (cached && !cached.failed) {
          try {
            copy = validateGeminiFile(readFileSync(join(this.outputDir, artifact.identity + '.' + cached.extension)), cached.extension);
            if (digest(copy) !== cached.token) cached = null;
          } catch { cached = null; }
        }
        if (!cached || cached.referenceToken !== referenceToken || cached.retryAt <= Date.now()) {
          if (downloads >= MAX_REMOTE_DOWNLOADS) { stats.deferred++; continue; }
          downloads++;
          try {
            const result = await this.loadRemote(artifact.remote, cached && copy ? { revision: cached.revision, extension: cached.extension } : null);
            const body = validateGeminiFile(result.unchanged ? copy : result.body, result.extension);
            cached = { referenceToken, token: digest(body), extension: result.extension, revision: result.revision, retryAt: Date.now() + REMOTE_CHECK_MS };
            copy = body;
          } catch (error) { cached = { referenceToken, failed: true, errorCode: ['gws_unavailable', 'not_found', 'access_denied'].includes(error.code) ? error.code : 'download_failed', retryAt: Date.now() + REMOTE_CHECK_MS }; }
          this.remoteCache.set(artifact.identity, cached);
        }
        if (cached.failed) { stats.failed++; stats.remoteFailed++; stats.remoteErrors[cached.errorCode] = (stats.remoteErrors[cached.errorCode] ?? 0) + 1; continue; }
        artifact.body = copy; artifact.extension = cached.extension; artifact.token = cached.token;
      }
      const path = join(this.outputDir, artifact.identity + '.' + artifact.extension);
      const stateKey = 'gemini.app.artifact.' + artifact.identity;
      const temp = join(dirname(path), '.gemini-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp');
      try {
        const body = Buffer.from(artifact.body); const previous = existsSync(path) ? readFileSync(path) : null;
        const onDisk = previous?.equals(body);
        if (onDisk && store.getState(stateKey) === artifact.token && store.byPathKey(path)?.missing_at === null) { stats.unchanged++; continue; }
        mkdirSync(this.outputDir, { recursive: true });
        if (!onDisk) { writeFileSync(temp, body, { mode: 0o600 }); renameSync(temp, path); }
        const result = await collector.ingestFile(store, path, { collector: 'gemini', provider: 'gemini', sessionRef: artifact.sessionRef, sessionTitle: artifact.title, createdAt: artifact.occurredAt, isDeliverable: true });
        if (!result.id) throw new Error('Gemini artifact was not indexed.');
        await collector.reindexArtifact(store, result.id); store.setState(stateKey, artifact.token);
        if (result.rule === 'inserted') stats.inserted++; else if (result.rule === 'updated') stats.updated++; else stats.unchanged++;
      } catch { stats.failed++; try { unlinkSync(temp); } catch {} }
    }
    if (stats.failed) code = stats.remoteFailed === stats.failed ? 'remote_unavailable' : 'partial';
    else if (stats.deferred) code = 'pending';
    store.setState('gemini.app.last_sweep_code', code);
    if (stats.errors || stats.failed) store.logIngest({ level: 'error', code: 'gemini_app_' + code, message: code === 'key_unavailable' ? 'Gemini Keychain access failed. Allow access and restart output-mesh.' : stats.remoteFailed ? 'Gemini output download failed. Check gws authentication and access to the original file.' : 'Gemini app collection failed. Check cache format and output access.' });
    return { ...stats, code };
  }
}
