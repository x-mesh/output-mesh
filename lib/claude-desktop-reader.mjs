import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CLAUDE_APP_ARTIFACTS_DIR, CLAUDE_CACHE_MAX_BODY_BYTES, CLAUDE_CACHE_MAX_ENTRIES, CLAUDE_CACHE_MAX_METADATA_BYTES, CLAUDE_CACHE_MAX_SCAN_BYTES, CLAUDE_DESKTOP_CACHE_DATA } from './paths.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HTML = /<\s*(?:!doctype\b|html\b|head\b|body\b)/i;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const uuidOf = (value) => { const match = String(value || '').match(UUID); return match ? match[0].toLowerCase() : null; };
const safe = (value, max) => { const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); return text ? text.slice(0, max || 160) : null; };
const versionCompare = (a, b) => { const aa = String(a || '').split(/[^0-9]+/).filter(Boolean).map(Number); const bb = String(b || '').split(/[^0-9]+/).filter(Boolean).map(Number); for (let i = 0; i < Math.max(aa.length, bb.length); i++) { const n = (aa[i] || 0) - (bb[i] || 0); if (n) return n; } return String(a || '').localeCompare(String(b || '')); };
function publicUrl(uuid, value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol === 'https:' && parsed.hostname === 'claude.ai' && new RegExp('^/artifacts/' + uuid + '$', 'i').test(parsed.pathname)) return parsed.toString().split('?')[0].split('#')[0];
  } catch {}
  return null;
}

function cacheUrl(bytes) {
  if (bytes.length < 28) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
  if (!length || length > 16 * 1024 || 24 + length > bytes.length) return null;
  const key = decoder.decode(bytes.subarray(24, 24 + length)).split('\0')[0];
  const at = key.indexOf('https://');
  return at >= 0 ? key.slice(at) : key;
}

function entryUrl(bytes) {
  const cached = cacheUrl(bytes);
  if (cached) return cached;
  if (bytes[0] !== 0x7b && bytes[0] !== 0x5b) return null;
  try {
    const value = JSON.parse(decoder.decode(bytes));
    return value.url || value.requestUrl || null;
  } catch { return null; }
}

function classify(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname === 'claude.ai' && /(?:^|\/)user_artifacts$/.test(parsed.pathname)) return { kind: 'metadata' };
    const host = parsed.hostname.match(/^([0-9a-f-]+)\.frame\.claudeusercontent\.com$/i);
    const path = parsed.pathname.match(/^\/api\/frame\/([^/]+)/i);
    const uuid = uuidOf(host ? host[1] : path ? path[1] : null) || uuidOf(parsed.pathname.match(/\/([^/]+)\.html$/i)?.[1]);
    if (!uuid) return null;
    return { kind: 'frame', uuid, version: safe((parsed.pathname.match(/\/_f\/([^/]+)/) || [])[1], 80) || safe(parsed.searchParams.get('version'), 80) || '0' };
  } catch { return null; }
}

function headersAt(bytes, offset) {
  const text = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + 64 * 1024)));
  const status = text.match(/HTTP\/1\.[01]\s+(\d{3})/);
  if (!status) return { headers: {}, bodyOffset: offset };
  const parts = text.split('\0');
  const headers = {};
  const terminator = text.indexOf('\0\0', parts[0].length);
  if (terminator >= 0) return { headers: Object.fromEntries(parts.slice(1, -1).filter((part) => part.includes(':')).map((part) => { const at = part.indexOf(':'); return [part.slice(0, at).toLowerCase(), part.slice(at + 1).trim()]; })), bodyOffset: offset + terminator + 2 };
  let bodyOffset = offset + (parts[0].length + 1);
  for (const part of parts.slice(1)) { if (!part) { bodyOffset += 1; break; } const at = part.indexOf(':'); if (at < 1) break; const name = part.slice(0, at).toLowerCase(); if (!/^[a-z0-9-]+$/.test(name)) break; headers[name] = part.slice(at + 1).trim(); bodyOffset += part.length + 1; }
  return { headers, bodyOffset };
}

function decodeBody(bytes, encoding, maxBytes = CLAUDE_CACHE_MAX_BODY_BYTES) {
  try {
    const name = String(encoding || '').toLowerCase();
    let decoded;
    if (name === 'gzip' || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      if (bytes.length < 18) return null;
      const declaredSize = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 4, 4).getUint32(0, true);
      if (declaredSize > maxBytes) return null;
      decoded = new Uint8Array((typeof Bun.gunzipSync === 'function' ? Bun.gunzipSync : gunzipSync)(bytes));
    }
    else if (name === 'br') decoded = new Uint8Array(brotliDecompressSync(bytes));
    else if (name === 'zstd' || (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd)) decoded = typeof Bun.zstdDecompressSync === 'function' ? new Uint8Array(Bun.zstdDecompressSync(bytes)) : null;
    else decoded = bytes;
    return decoded && decoded.length <= maxBytes ? decoded : null;
  } catch { return null; }
}

function bodyCandidates(bytes, encoding, maxBytes = CLAUDE_CACHE_MAX_BODY_BYTES) {
  const candidates = [];
  const add = (value, forcedEncoding = encoding) => { const decoded = decodeBody(value, forcedEncoding, maxBytes); if (decoded && decoded.length) candidates.push(decoded); };
  add(bytes);
  for (let i = 0; i + 4 <= bytes.length; i++) {
    const zstd = bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd;
    const gzip = bytes[i] === 0x1f && bytes[i + 1] === 0x8b;
    if (zstd || gzip) {
      if (zstd) for (let end = bytes.length; end > i + 16; end--) { try { const decoded = Bun.zstdDecompressSync(bytes.subarray(i, end)); if (decoded.length <= maxBytes) candidates.push(new Uint8Array(decoded)); break; } catch {} }
      else add(bytes.subarray(i), 'gzip');
    }
  }
  const text = decoder.decode(bytes);
  for (const marker of ['<!doctype', '<html', '{', '[']) {
    const at = text.toLowerCase().indexOf(marker);
    if (at >= 0) candidates.push(encoder.encode(text.slice(at)));
  }
  return candidates;
}

function redact(bytes) {
  let text = decoder.decode(bytes);
  text = text.replace(/(<(?:input|meta)[^>]*(?:token|cookie|authorization|secret)[^>]*>)/gi, '');
  text = text.replace(/(["'](?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token)["']\s*[:=]\s*["'])[^"']+(["'])/gi, '$1$2');
  return encoder.encode(text);
}

function titleFromHtml(bytes) {
  const match = decoder.decode(bytes).match(/<title[^>]*>\s*([^<]{1,160})\s*<\/title>/i);
  return match ? safe(match[1]) : null;
}

function records(value) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node)) {
      const uuid = uuidOf(node.latest_published_artifact_uuid || node.artifact_uuid || node.artifact_identifier || node.artifactUuid || node.uuid);
      if (uuid) out.push({ uuid, title: safe(node.title || node.name), slug: safe(node.slug, 120), version: safe(node.version || node.published_version || node.latest_version || node.cursor, 80), pageUrl: safe(node.url || node.page_url || node.public_url, 240), createdAt: node.created_at || node.createdAt, updatedAt: node.updated_at || node.updatedAt });
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return out;
}

export function parseClaudeCacheEntry(input, { maxBodyBytes = CLAUDE_CACHE_MAX_BODY_BYTES, maxMetadataBytes = CLAUDE_CACHE_MAX_METADATA_BYTES } = {}) {
  const bytes = input instanceof Uint8Array ? input : encoder.encode(String(input));
  if (bytes[0] === 0x7b || bytes[0] === 0x5b) {
    try {
      const envelope = JSON.parse(decoder.decode(bytes));
      const info = classify(envelope.url || envelope.requestUrl || '');
      if (!info) return null;
      const headers = Object.fromEntries(Object.entries(envelope.headers || envelope.responseHeaders || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
      const raw = typeof envelope.body === 'string' && envelope.body.startsWith('base64:')
        ? Uint8Array.from(Buffer.from(envelope.body.slice(7), 'base64'))
        : encoder.encode(String(envelope.body || ''));
      const payloadLimit = info.kind === 'metadata' ? maxMetadataBytes : maxBodyBytes;
      const payload = decodeBody(raw, headers['content-encoding'], payloadLimit);
      if (!payload) return null;
      if (info.kind === 'metadata') return { kind: 'metadata', records: records(JSON.parse(decoder.decode(payload))), headers: {} };
      const body = redact(payload);
      const text = decoder.decode(body);
      return body.length && HTML.test(text) && /<\/html\s*>/i.test(text) ? { kind: 'frame', uuid: info.uuid, version: info.version, body, headers: {} } : null;
    } catch { return null; }
  }
  const url = cacheUrl(bytes);
  const info = url ? classify(url) : null;
  if (!info) return null;
  const statusAt = decoder.decode(bytes).indexOf('HTTP/1.1');
  const parsed = statusAt >= 0 ? headersAt(bytes, statusAt) : { headers: {}, bodyOffset: 0 };
  const rawBody = bytes.subarray(parsed.bodyOffset);
  const payloadLimit = info.kind === 'metadata' ? maxMetadataBytes : maxBodyBytes;
  const payloads = [...bodyCandidates(bytes, parsed.headers['content-encoding'], payloadLimit), ...bodyCandidates(rawBody, parsed.headers['content-encoding'], payloadLimit), rawBody].filter((payload) => payload.length <= payloadLimit);
  if (!payloads.length) return null;
  if (info.kind === 'metadata') {
    for (const payload of payloads) { try { const value = JSON.parse(decoder.decode(payload)); return { kind: 'metadata', records: records(value), headers: {} }; } catch {} }
    return null;
  }
  for (const payload of payloads) { const body = redact(payload); const text = decoder.decode(body); if (body.length && HTML.test(text) && /<\/html\s*>/i.test(text)) return { kind: 'frame', uuid: info.uuid, version: info.version, body, headers: {} }; }
  return null;
}

export function parseSimpleCacheEntry(input, options) { return parseClaudeCacheEntry(input, options); }

function normalize(item) {
  const uuid = uuidOf(item.uuid);
  if (!uuid || !item.body || item.body.length > CLAUDE_CACHE_MAX_BODY_BYTES) return null;
  const body = redact(item.body);
  return { uuid, body, version: safe(item.version, 80) || '0', title: safe(item.title) || titleFromHtml(body), slug: safe(item.slug, 120), pageUrl: publicUrl(uuid, item.pageUrl), createdAt: Number.isFinite(Date.parse(item.createdAt)) ? Math.floor(Date.parse(item.createdAt) / 1000) : null, updatedAt: Number.isFinite(Date.parse(item.updatedAt)) ? Math.floor(Date.parse(item.updatedAt) / 1000) : null, sourceMtime: item.sourceMtime || 0 };
}

export class ClaudeDesktopReader {
  constructor({ cacheDataRoot = CLAUDE_DESKTOP_CACHE_DATA, outputDir = CLAUDE_APP_ARTIFACTS_DIR, maxEntries = CLAUDE_CACHE_MAX_ENTRIES, maxScanBytes = CLAUDE_CACHE_MAX_SCAN_BYTES, batchSize = 64 } = {}) {
    this.cacheDataRoot = cacheDataRoot;
    this.outputDir = outputDir;
    this.maxEntries = maxEntries;
    this.maxScanBytes = maxScanBytes;
    this.batchSize = batchSize;
    this.entryCache = new Map();
    this.cursor = 0;
  }
  available() { return existsSync(this.cacheDataRoot); }
  async scan() {
    const metadata = new Map(); const frames = new Map(); const stats = { scanned: 0, bytes: 0, metadata: 0, bodies: 0, skipped: 0, errors: 0 };
    const noteError = () => { stats.errors = 1; };
    if (!this.available()) return { metadata, frames, stats, available: false };
    let entries; try { entries = (await readdir(this.cacheDataRoot, { withFileTypes: true })).filter((entry) => entry.isFile()).slice(0, this.maxEntries); } catch { noteError(); return { metadata, frames, stats, available: true }; }
    const seen = new Set();
    for (let index = 0; index < entries.length; index++) {
      if (stats.bytes >= this.maxScanBytes) break;
      const entry = entries[index]; const path = join(this.cacheDataRoot, entry.name); seen.add(path);
      let current;
      try { current = await stat(path); } catch { noteError(); continue; }
      if (stats.bytes + current.size > this.maxScanBytes) break;
      const signature = String(current.ino) + ':' + current.size + ':' + current.mtimeMs;
      const cached = this.entryCache.get(path);
      let parsed;
      if (cached?.signature === signature) { parsed = cached.parsed; if (cached.invalid) noteError(); stats.skipped++; }
      else {
        try {
          const bytes = await readFile(path); stats.scanned++; stats.bytes += bytes.length;
          const after = await stat(path);
          if (after.size !== current.size || after.mtimeMs !== current.mtimeMs) { noteError(); this.entryCache.delete(path); continue; }
          parsed = parseClaudeCacheEntry(bytes);
          const invalid = !parsed && Boolean(classify(entryUrl(bytes) || ''));
          if (invalid) noteError();
          this.entryCache.set(path, { signature, parsed, invalid });
        } catch { noteError(); this.entryCache.delete(path); continue; }
      }
      if (!parsed) continue;
      if (parsed.kind === 'metadata') { parsed.records.forEach((record) => metadata.set(record.uuid, { ...(metadata.get(record.uuid) || {}), ...record, sourceMtime: current.mtimeMs })); stats.metadata += parsed.records.length; }
      else { frames.set(parsed.uuid, [...(frames.get(parsed.uuid) || []), { ...parsed, sourceMtime: current.mtimeMs }]); stats.bodies++; }
      if ((index + 1) % this.batchSize === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    for (const path of this.entryCache.keys()) if (!seen.has(path)) this.entryCache.delete(path);
    this.cursor = entries.length ? (this.cursor + entries.length) % entries.length : 0;
    return { metadata, frames, stats, available: true };
  }
  async artifacts() {
    const result = await this.scan(); const artifacts = [];
    for (const [uuid, versions] of result.frames) { const body = versions.sort((a, b) => versionCompare(b.version, a.version) || b.sourceMtime - a.sourceMtime)[0]; const item = normalize({ ...(result.metadata.get(uuid) || {}), ...body, uuid }); if (item) artifacts.push(item); }
    return { artifacts, stats: { ...result.stats, found: artifacts.length }, available: result.available };
  }
  async sweep(store) {
    const found = await this.artifacts(); const stats = { ...found.stats, inserted: 0, updated: 0, unchanged: 0, failed: 0 };
    store.setState('claude.last_sweep_at', Math.floor(Date.now() / 1000));
    if (!found.available) { store.setState('claude.last_sweep_code', 'unavailable'); return { ...stats, available: false }; }
    if (!found.artifacts.length) { store.setState('claude.last_sweep_code', found.stats.errors ? 'entry_invalid' : 'ok'); return { ...stats, available: true }; }
    try { mkdirSync(this.outputDir, { recursive: true }); } catch { store.setState('claude.last_sweep_code', 'output_unavailable'); return { ...stats, failed: found.artifacts.length, available: true }; }
    const collector = await import('./collector.mjs');
    for (const artifact of found.artifacts) {
      const versionKey = 'claude.version.' + artifact.uuid;
      const previousVersion = store.getState(versionKey);
      if (previousVersion && versionCompare(artifact.version, previousVersion) < 0) { stats.unchanged++; continue; }
      const path = join(this.outputDir, artifact.uuid + '.html'); const temp = join(this.outputDir, '.' + artifact.uuid + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp');
      try {
        const old = existsSync(path) ? readFileSync(path) : null;
        const onDisk = Boolean(old) && Buffer.from(old).equals(Buffer.from(artifact.body));
        // 사본은 카탈로그를 다시 만들어도 남는다. 사본만 보고 건너뛰면 새 카탈로그가 이 아티팩트를 영영 받지 못한다.
        if (onDisk && previousVersion === artifact.version) { stats.unchanged++; continue; }
        if (!onDisk) { writeFileSync(temp, artifact.body, { mode: 0o600 }); renameSync(temp, path); }
        const ingested = await collector.ingestFile(store, path, { collector: 'claude-app', provider: 'claude-app', sessionRef: artifact.uuid, sessionTitle: artifact.title, prompt: artifact.version ? 'version ' + artifact.version : null, createdAt: artifact.updatedAt || artifact.createdAt || Math.floor(Date.now() / 1000) });
        if (ingested.id) await collector.reindexArtifact(store, ingested.id); if (ingested.rule === 'inserted') stats.inserted++; else if (ingested.rule === 'updated') stats.updated++; else stats.unchanged++;
        if (ingested.id) store.setState(versionKey, artifact.version);
      } catch { stats.failed++; try { unlinkSync(temp); } catch {} }
    }
    store.setState('claude.last_sweep_code', stats.failed ? 'partial' : found.stats.errors ? 'entry_invalid' : 'ok'); return { ...stats, available: true };
  }
}

export function claudeArtifactPath(uuid, outputDir = CLAUDE_APP_ARTIFACTS_DIR) { const safeUuid = uuidOf(uuid); return safeUuid ? join(outputDir, safeUuid + '.html') : null; }
