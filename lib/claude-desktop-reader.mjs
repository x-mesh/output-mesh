import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { dirname, join, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { CLAUDE_APP_ARTIFACTS_DIR, CLAUDE_CACHE_MAX_BODY_BYTES, CLAUDE_CACHE_MAX_ENTRIES, CLAUDE_CACHE_MAX_METADATA_BYTES, CLAUDE_CACHE_MAX_SCAN_BYTES, CLAUDE_DESKTOP_CACHE_DATA, CLAUDE_OUTPUTS_PREFIX, CLAUDE_OUTPUT_MAX_DEPTH, CLAUDE_WIDGETS_DIR, CLAUDE_WIDGET_NAME_MAX_CHARS, nfc } from './paths.mjs';

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

// /home/claude 는 채팅의 작업 폴더라 Claude Code 의 세션 임시 폴더처럼 모으지 않는다. 사람에게 건넨 파일은 outputs 에 있다.
function outputsRelative(value) {
  const path = String(value || '');
  if (!path.startsWith(CLAUDE_OUTPUTS_PREFIX)) return null;
  const parts = path.slice(CLAUDE_OUTPUTS_PREFIX.length).split('/');
  if (parts.length > CLAUDE_OUTPUT_MAX_DEPTH || parts.some((part) => !part || part.startsWith('.') || /[\u0000-\u001f\\]/.test(part))) return null;
  return parts.map(nfc).join('/');
}

function classify(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname === 'claude.ai') {
      if (/(?:^|\/)user_artifacts$/.test(parsed.pathname)) return { kind: 'metadata' };
      const conversation = uuidOf(parsed.pathname.match(/^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)$/)?.[1]);
      if (conversation) return { kind: 'conversation', uuid: conversation };
      const download = uuidOf(parsed.pathname.match(/^\/api\/organizations\/[^/]+\/conversations\/([^/]+)\/wiggle\/download-file$/)?.[1]);
      if (download) { const path = outputsRelative(parsed.searchParams.get('path')); return path ? { kind: 'download', uuid: download, path } : null; }
      const frame = uuidOf(parsed.pathname.match(/^\/api\/frame\/([^/]+)/)?.[1]);
      return frame ? { kind: 'frame', uuid: frame, version: safe(parsed.searchParams.get('version'), 80) || '0' } : null;
    }
    // 프레임 호스트는 _runtime/*.js 같은 하위 리소스도 내려준다. 아티팩트 본문은 /_f/<버전>/ 뿐이다.
    const frame = uuidOf(parsed.hostname.match(/^([0-9a-f-]+)\.frame\.claudeusercontent\.com$/i)?.[1]);
    const version = parsed.pathname.match(/^\/_f\/([^/]+)/)?.[1];
    return frame && version ? { kind: 'frame', uuid: frame, version: safe(version, 80) || '0' } : null;
  } catch { return null; }
}

// Chromium Simple Cache 의 엔트리 파일은 헤더 24바이트, 키, 본문(stream 1), EOF, HTTP 헤더(stream 0), EOF 순이다.
const SIMPLE_EOF_MAGIC = Buffer.from('d8410d97456ffaf4', 'hex');
function simpleCacheParts(bytes) {
  const keyLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
  const start = 24 + keyLength;
  const eof = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(SIMPLE_EOF_MAGIC, start);
  if (eof < 0) return null;
  const tail = decoder.decode(bytes.subarray(eof + SIMPLE_EOF_MAGIC.length));
  const headers = {};
  for (const part of tail.split('\0')) { const at = part.indexOf(':'); if (at > 0 && /^[a-z0-9-]+$/i.test(part.slice(0, at))) headers[part.slice(0, at).toLowerCase()] = part.slice(at + 1).trim(); }
  return { status: tail.match(/HTTP\/[\d.]+ (\d{3})/)?.[1] ?? null, headers, body: bytes.subarray(start, eof) };
}

const seconds = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; };
const fileSafe = (value) => nfc(String(value)).replace(/[/\\:\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, CLAUDE_WIDGET_NAME_MAX_CHARS).trim() || 'widget';
const escapeHtml = (value) => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const widgetDocument = (title, code) => encoder.encode(`<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>\n${code}\n</body></html>\n`);
const contentToken = (bytes) => createHash('sha256').update(bytes).digest('hex');

function conversationOf(value) {
  const uuid = uuidOf(value?.uuid);
  if (!uuid || !Array.isArray(value.chat_messages)) return null;
  const byId = new Map(value.chat_messages.map((message) => [message.uuid, message]));
  // tree=True 응답은 버린 분기까지 담는다. 다시 쓴 답의 파일이 섞이지 않게 보이는 분기만 따라간다.
  const chain = [];
  for (let id = value.current_leaf_message_uuid; byId.has(id) && chain.length < byId.size; id = byId.get(id).parent_message_uuid) chain.unshift(byId.get(id));
  const files = new Map(); const widgets = new Map();
  for (const message of chain) {
    const at = seconds(message.created_at);
    for (const block of message.content ?? []) {
      if (block?.type !== 'tool_use' || !block.input) continue;
      const { input } = block;
      if (block.name === 'create_file' || block.name === 'str_replace') {
        const path = outputsRelative(input.path);
        if (!path) continue;
        if (block.name === 'create_file') { if (typeof input.file_text === 'string') files.set(path, { text: input.file_text, at }); continue; }
        // str_replace 는 정확히 한 곳이 맞을 때만 바꾼다. 그 밖의 경우에는 원래 도구도 파일을 그대로 두었다.
        const file = files.get(path);
        const first = file && typeof input.old_str === 'string' && input.old_str ? file.text.indexOf(input.old_str) : -1;
        if (first >= 0 && file.text.indexOf(input.old_str, first + 1) < 0) files.set(path, { text: file.text.slice(0, first) + String(input.new_str ?? '') + file.text.slice(first + input.old_str.length), at });
      } else if (block.name === 'visualize:show_widget' && typeof input.widget_code === 'string') {
        const title = safe(input.title) || 'widget';
        widgets.set(fileSafe(title), { title, code: input.widget_code, at });
      }
    }
  }
  return { kind: 'conversation', uuid, name: safe(value.name), updatedAt: seconds(value.updated_at), messages: chain.length, files: [...files].map(([path, file]) => ({ path, ...file })), widgets: [...widgets].map(([name, widget]) => ({ name, ...widget })) };
}

function parseResponse(info, raw, headers, maxBodyBytes) {
  const encoding = headers['content-encoding'];
  if (info.kind === 'download') {
    // 받는 도중에 캐시된 응답은 잘려 있다. 길이를 확인할 수 없으면 잘린 파일을 사본으로 남기게 된다.
    if (Number(headers['content-length']) !== raw.length) return null;
    const body = encoding ? decodeBody(raw, encoding, maxBodyBytes) : raw;
    return body && body.length <= maxBodyBytes ? { kind: 'download', uuid: info.uuid, path: info.path, body: Uint8Array.from(body) } : null;
  }
  const payload = decodeBody(raw, encoding, maxBodyBytes);
  if (!payload) return null;
  try { return conversationOf(JSON.parse(decoder.decode(payload))); } catch { return null; }
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
      // artifact_identifier 는 UUID 가 아닌 이름일 때가 많다. || 로 고르면 그 뒤의 uuid 까지 가지 못한다.
      const uuid = [node.latest_published_artifact_uuid, node.artifact_uuid, node.artifact_identifier, node.artifactUuid, node.uuid].map(uuidOf).find(Boolean);
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
      if (info.kind === 'conversation' || info.kind === 'download') return parseResponse(info, raw, headers, maxBodyBytes);
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
  if (info.kind === 'conversation' || info.kind === 'download') {
    const parts = simpleCacheParts(bytes);
    if (!parts?.status) return null;
    // 지운 대화의 404 도 캐시에 남는다. 깨진 항목이 아니라 서버의 답이라 오류로 세지 않는다.
    return parts.status === '200' ? parseResponse(info, parts.body, parts.headers, maxBodyBytes) : { kind: 'unavailable', status: parts.status };
  }
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
  const version = safe(item.version, 80) || '0';
  const createdAt = seconds(item.createdAt); const updatedAt = seconds(item.updatedAt);
  return { kind: 'frame', uuid, body, version, title: safe(item.title) || titleFromHtml(body), slug: safe(item.slug, 120), pageUrl: publicUrl(uuid, item.pageUrl), createdAt, updatedAt, sourceMtime: item.sourceMtime || 0, relPath: uuid + '.html', stateKey: 'claude.version.' + uuid, token: version, sessionRef: uuid, prompt: 'version ' + version, occurredAt: updatedAt || createdAt };
}

/** 대화에서 되짚은 파일과 위젯, 그리고 내려받은 파일. 같은 자리면 더 새것이 이긴다. */
function conversationArtifacts(conversations, downloads) {
  const files = new Map();
  for (const conversation of conversations.values()) {
    const origin = { sessionRef: conversation.uuid, title: conversation.name };
    for (const file of conversation.files) files.set(conversation.uuid + '/' + file.path, { ...origin, kind: 'file', body: encoder.encode(file.text), occurredAt: file.at ?? conversation.updatedAt });
    for (const widget of conversation.widgets) files.set(conversation.uuid + '/' + CLAUDE_WIDGETS_DIR + '/' + widget.name + '.html', { ...origin, kind: 'widget', body: widgetDocument(widget.title, widget.code), occurredAt: widget.at ?? conversation.updatedAt });
  }
  // 대화에서 되짚은 본문은 bash 로 고친 내용을 모른다. 내려받은 파일은 서버가 준 그대로다.
  // 다만 내려받은 뒤에 대화가 그 파일을 또 고쳤다면 되짚은 본문이 더 새것이다.
  for (const [relPath, download] of downloads) {
    const conversation = conversations.get(download.uuid);
    const rebuilt = files.get(relPath); const downloadedAt = Math.floor(download.sourceMtime / 1000);
    if (rebuilt?.occurredAt > downloadedAt) continue;
    files.set(relPath, { kind: 'download', sessionRef: download.uuid, title: conversation?.name ?? null, body: download.body, occurredAt: rebuilt?.occurredAt ?? conversation?.updatedAt ?? downloadedAt });
  }
  return [...files].map(([relPath, file]) => ({ ...file, relPath, stateKey: 'claude.file.' + relPath, token: contentToken(file.body), prompt: null }));
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
    const metadata = new Map(); const frames = new Map(); const conversations = new Map(); const downloads = new Map(); const stats = { scanned: 0, bytes: 0, metadata: 0, bodies: 0, conversations: 0, downloads: 0, skipped: 0, errors: 0 };
    const noteError = () => { stats.errors = 1; };
    if (!this.available()) return { metadata, frames, conversations, downloads, stats, available: false };
    let entries; try { entries = (await readdir(this.cacheDataRoot, { withFileTypes: true })).filter((entry) => entry.isFile()).slice(0, this.maxEntries); } catch { noteError(); return { metadata, frames, conversations, downloads, stats, available: true }; }
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
      else if (parsed.kind === 'conversation') {
        // 같은 대화가 질의 문자열만 다른 응답으로 여럿 캐시된다(consistency=strong/eventual). 가장 새 것을 쓴다.
        const known = conversations.get(parsed.uuid);
        if (!known || (parsed.updatedAt ?? 0) > (known.updatedAt ?? 0) || ((parsed.updatedAt ?? 0) === (known.updatedAt ?? 0) && parsed.messages > known.messages)) conversations.set(parsed.uuid, parsed);
        stats.conversations++;
      }
      else if (parsed.kind === 'download') {
        const relPath = parsed.uuid + '/' + parsed.path; const known = downloads.get(relPath);
        if (!known || current.mtimeMs > known.sourceMtime) downloads.set(relPath, { ...parsed, sourceMtime: current.mtimeMs });
        stats.downloads++;
      }
      else if (parsed.kind === 'frame') { frames.set(parsed.uuid, [...(frames.get(parsed.uuid) || []), { ...parsed, sourceMtime: current.mtimeMs }]); stats.bodies++; }
      if ((index + 1) % this.batchSize === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    for (const path of this.entryCache.keys()) if (!seen.has(path)) this.entryCache.delete(path);
    this.cursor = entries.length ? (this.cursor + entries.length) % entries.length : 0;
    return { metadata, frames, conversations, downloads, stats, available: true };
  }
  async artifacts() {
    const result = await this.scan(); const artifacts = [];
    for (const [uuid, versions] of result.frames) { const body = versions.sort((a, b) => versionCompare(b.version, a.version) || b.sourceMtime - a.sourceMtime)[0]; const item = normalize({ ...(result.metadata.get(uuid) || {}), ...body, uuid }); if (item) artifacts.push(item); }
    artifacts.push(...conversationArtifacts(result.conversations, result.downloads));
    const kinds = {}; for (const artifact of artifacts) kinds[artifact.kind] = (kinds[artifact.kind] || 0) + 1;
    return { artifacts, stats: { ...result.stats, found: artifacts.length, kinds }, available: result.available };
  }
  async sweep(store) {
    const found = await this.artifacts(); const stats = { ...found.stats, inserted: 0, updated: 0, unchanged: 0, failed: 0 };
    store.setState('claude.last_sweep_at', Math.floor(Date.now() / 1000));
    if (!found.available) { store.setState('claude.last_sweep_code', 'unavailable'); return { ...stats, available: false }; }
    if (!found.artifacts.length) { store.setState('claude.last_sweep_code', found.stats.errors ? 'entry_invalid' : 'ok'); return { ...stats, available: true }; }
    try { mkdirSync(this.outputDir, { recursive: true }); } catch { store.setState('claude.last_sweep_code', 'output_unavailable'); return { ...stats, failed: found.artifacts.length, available: true }; }
    const collector = await import('./collector.mjs');
    for (const artifact of found.artifacts) {
      const previous = store.getState(artifact.stateKey);
      if (artifact.kind === 'frame' && previous && versionCompare(artifact.token, previous) < 0) { stats.unchanged++; continue; }
      const path = join(this.outputDir, ...artifact.relPath.split('/'));
      if (!path.startsWith(this.outputDir + sep)) { stats.failed++; continue; }
      const temp = join(dirname(path), '.claude-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp');
      try {
        mkdirSync(dirname(path), { recursive: true });
        const old = existsSync(path) ? readFileSync(path) : null;
        const onDisk = Boolean(old) && Buffer.from(old).equals(Buffer.from(artifact.body));
        // 사본은 카탈로그를 다시 만들어도 남는다. 사본만 보고 건너뛰면 새 카탈로그가 이 아티팩트를 영영 받지 못한다.
        if (onDisk && previous === artifact.token) { stats.unchanged++; continue; }
        if (!onDisk) { writeFileSync(temp, artifact.body, { mode: 0o600 }); renameSync(temp, path); }
        const ingested = await collector.ingestFile(store, path, { collector: 'claude-app', provider: 'claude-app', sessionRef: artifact.sessionRef, sessionTitle: artifact.title, prompt: artifact.prompt, createdAt: artifact.occurredAt || Math.floor(Date.now() / 1000) });
        if (ingested.id) await collector.reindexArtifact(store, ingested.id); if (ingested.rule === 'inserted') stats.inserted++; else if (ingested.rule === 'updated') stats.updated++; else stats.unchanged++;
        if (ingested.id) store.setState(artifact.stateKey, artifact.token);
      } catch { stats.failed++; try { unlinkSync(temp); } catch {} }
    }
    store.setState('claude.last_sweep_code', stats.failed ? 'partial' : found.stats.errors ? 'entry_invalid' : 'ok'); return { ...stats, available: true };
  }
}

export function claudeArtifactPath(uuid, outputDir = CLAUDE_APP_ARTIFACTS_DIR) { const safeUuid = uuidOf(uuid); return safeUuid ? join(outputDir, safeUuid + '.html') : null; }
