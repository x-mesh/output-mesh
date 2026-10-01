import { existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { GEMINI_MAX_LINE_BYTES, GEMINI_MAX_LOG_BYTES_PER_SWEEP, GEMINI_MAX_SESSIONS, GEMINI_READ_CHUNK_BYTES, geminiRoots, nfc } from './paths.mjs';
import { isIndexablePath } from './session-logs.mjs';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content']);
const MAX_TITLE_CHARS = 200;
const ROOT_PRIORITY = new Map(['antigravity-cli', 'antigravity-ide', 'antigravity'].map((name, index) => [name, index]));

function boundedText(value, max = MAX_TITLE_CHARS) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\b(bearer)\s+[^\s]+/gi, '$1 [redacted]')
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function timestamp(value, fallback = 0) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
}

function isScratchPath(path, roots) {
  return roots.some((root) => path === join(root, 'scratch') || path.startsWith(join(root, 'scratch') + '/'));
}

function isSensitivePath(path) {
  const name = basename(path).toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name === 'credentials.json' || name.endsWith('_accounts.json')
    || name === 'credentials' || name.startsWith('oauth') || name === 'id_rsa' || name === 'id_ed25519'
    || name === '.netrc' || name === '.npmrc' || name === '.pypirc' || name === '.git-credentials' || name.endsWith('.pem')
    || ['/.ssh/', '/.aws/', '/.gnupg/', '/.config/gcloud/'].some((segment) => path.includes(segment));
}

export function parseGeminiTranscriptLine(line, state = { title: null }) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > GEMINI_MAX_LINE_BYTES) return { records: [], invalid: true };
  let entry;
  try { entry = JSON.parse(line); } catch { return { records: [], invalid: true }; }
  if (!state.title && entry?.type === 'USER_INPUT') state.title = boundedText(entry.content);
  const at = timestamp(entry?.created_at);
  const records = [];
  for (const call of Array.isArray(entry?.tool_calls) ? entry.tool_calls : []) {
    if (!WRITE_TOOLS.has(call?.name)) continue;
    const path = call?.args?.TargetFile;
    if (typeof path === 'string' && isAbsolute(path)) records.push({ path: nfc(path), at });
  }
  return { records, invalid: false };
}

function canonicalName(name) {
  if (!name || name.startsWith('.') || name.endsWith('.metadata.json') || name.includes('.resolved') || isSensitivePath(name)) return false;
  return true;
}

async function regularFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function canonicalFiles(sessionDir) {
  const out = [];
  let entries;
  try { entries = await readdir(sessionDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isFile() && canonicalName(entry.name)) out.push({ path: join(sessionDir, entry.name), rel: entry.name });
  }
  const artifactsDir = join(sessionDir, 'artifacts');
  try {
    for (const entry of await readdir(artifactsDir, { withFileTypes: true })) {
      if (entry.isFile() && canonicalName(entry.name)) out.push({ path: join(artifactsDir, entry.name), rel: `artifacts/${entry.name}` });
    }
  } catch {}
  return out;
}

export class GeminiReader {
  constructor({ home, roots = geminiRoots(home), maxSessions = GEMINI_MAX_SESSIONS, maxBytes = GEMINI_MAX_LOG_BYTES_PER_SWEEP, batchSize = 64 } = {}) {
    this.roots = roots;
    this.maxSessions = maxSessions;
    this.maxBytes = maxBytes;
    this.batchSize = batchSize;
    this.tails = new Map();
    this.logRecords = new Map();
    // 이미 알린 깨진 줄. Antigravity 가 사용 중인 트랜스크립트를 새로 쓰면 처음부터 다시 읽는데, 그때마다 알리면 같은 줄이 계속 쌓인다.
    this.reportedLines = new Set();
  }

  availableRoots() { return this.roots.filter((root) => existsSync(join(root, 'brain'))); }
  available() { return this.availableRoots().length > 0; }
  get brainRoots() { return this.roots.map((root) => join(root, 'brain')); }

  async readLog(path, sessionRef, root, budget) {
    const state = this.tails.get(path) ?? { ino: null, offset: 0, line: 0, title: null };
    let info;
    try { info = await stat(path); } catch { return { records: [], bytes: 0, errors: 1, invalid: [] }; }
    if (state.ino !== info.ino || info.size < state.offset) {
      Object.assign(state, { ino: info.ino, offset: 0, line: 0, title: null, droppingLine: false });
      this.logRecords.delete(path);
    }
    if (state.offset >= info.size || budget <= 0) { this.tails.set(path, state); return { records: [], bytes: 0, errors: 0, invalid: [] }; }
    const length = Math.min(info.size - state.offset, budget, GEMINI_READ_CHUNK_BYTES);
    const handle = await open(path, 'r');
    let bytes;
    try { bytes = Buffer.allocUnsafe(length); const result = await handle.read(bytes, 0, length, state.offset); bytes = bytes.subarray(0, result.bytesRead); } finally { await handle.close(); }
    // 깨진 줄은 읽기 실패가 아니라 Antigravity 가 쓴 파일의 상태다. 건너뛰고 몇째 줄인지만 돌려준다.
    const invalid = [];
    let prefix = 0;
    if (state.droppingLine) {
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) { state.offset += bytes.length; this.tails.set(path, state); return { records: [], bytes: bytes.length, errors: 0, invalid }; }
      prefix = newline + 1;
      state.droppingLine = false;
      state.line += 1;
      bytes = bytes.subarray(prefix);
    }
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      state.offset += prefix;
      if (bytes.length >= GEMINI_MAX_LINE_BYTES) {
        state.offset += bytes.length;
        state.droppingLine = true;
        invalid.push({ line: state.line + 1, reason: 'too-long' });
      }
      this.tails.set(path, state);
      return { records: [], bytes: bytes.length + prefix, errors: 0, invalid };
    }
    const records = [];
    for (const line of bytes.toString('utf8', 0, lastNewline).split('\n')) {
      state.line += 1;
      if (!line) continue;
      const parsed = parseGeminiTranscriptLine(line, state);
      if (parsed.invalid) invalid.push({ line: state.line, reason: Buffer.byteLength(line) > GEMINI_MAX_LINE_BYTES ? 'too-long' : 'not-json' });
      for (const record of parsed.records) records.push({ ...record, at: record.at || Math.floor(info.mtimeMs / 1000), sessionRef, title: state.title, root, source: 'transcript' });
    }
    state.offset += prefix + lastNewline + 1;
    this.tails.set(path, state);
    return { records, bytes: bytes.length, errors: 0, invalid };
  }

  async scan() {
    const stats = { roots: 0, sessions: 0, logs: 0, bytes: 0, writes: 0, artifacts: 0, missing: 0, skipped: 0, invalidLines: 0, errors: 0 };
    const invalid = [];
    const seenLogs = new Set();
    const artifacts = new Map();
    const activeRoots = this.availableRoots();
    stats.roots = activeRoots.length;
    let seenSessions = 0;
    for (const root of activeRoots) {
      const brain = join(root, 'brain');
      let sessions;
      try { sessions = await readdir(brain, { withFileTypes: true }); } catch { stats.errors = 1; continue; }
      sessions = sessions.filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sessions) {
        if (seenSessions++ >= this.maxSessions || stats.bytes >= this.maxBytes) break;
        stats.sessions++;
        const sessionRef = entry.name.toLowerCase();
        const sessionDir = join(brain, entry.name);
        const full = join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
        const compact = join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl');
        const logPath = existsSync(full) ? full : existsSync(compact) ? compact : null;
        let title = null;
        if (logPath) {
          seenLogs.add(logPath);
          stats.logs++;
          try {
            const read = await this.readLog(logPath, sessionRef, root, this.maxBytes - stats.bytes);
            stats.bytes += read.bytes; stats.errors = Math.min(1, stats.errors + read.errors);
            for (const bad of read.invalid) {
              stats.invalidLines++;
              const key = `${logPath}:${bad.line}:${bad.reason}`;
              if (this.reportedLines.has(key)) continue;
              this.reportedLines.add(key);
              invalid.push({ path: logPath, ...bad });
            }
            const known = this.logRecords.get(logPath) ?? new Map();
            for (const record of read.records) known.set(`${record.sessionRef}:${record.path}`, record);
            this.logRecords.set(logPath, known);
            title = this.tails.get(logPath)?.title ?? null;
          } catch { stats.errors = 1; }
        }
        for (const file of await canonicalFiles(sessionDir)) {
          let info;
          try { info = await stat(file.path); } catch { stats.errors = 1; continue; }
          if (!info.isFile()) continue;
          const key = `${sessionRef}:${file.rel}`;
          const candidate = { path: nfc(file.path), sessionRef, title, at: Math.floor(info.mtimeMs / 1000), root, source: 'artifact', rel: file.rel, mtimeMs: info.mtimeMs };
          const current = artifacts.get(key);
          const candidatePriority = ROOT_PRIORITY.get(basename(root)) ?? 99;
          const currentPriority = current ? ROOT_PRIORITY.get(basename(current.root)) ?? 99 : 99;
          if (!current || candidate.mtimeMs > current.mtimeMs || (candidate.mtimeMs === current.mtimeMs && candidatePriority < currentPriority)) artifacts.set(key, candidate);
        }
        if (stats.sessions % this.batchSize === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (seenSessions >= this.maxSessions || stats.bytes >= this.maxBytes) break;
    }
    for (const path of this.logRecords.keys()) if (!seenLogs.has(path)) this.logRecords.delete(path);
    for (const path of this.tails.keys()) if (!seenLogs.has(path)) this.tails.delete(path);
    const writes = [...this.logRecords.entries()].flatMap(([path, records]) => {
      const title = this.tails.get(path)?.title ?? null;
      return [...records.values()].map((record) => ({ ...record, title: record.title ?? title }));
    });
    const acceptedWrites = [];
    const newest = new Map();
    for (const record of writes) {
      if (isScratchPath(record.path, activeRoots) || isSensitivePath(record.path) || !isIndexablePath(record.path)) { stats.skipped++; continue; }
      if (!await regularFile(record.path)) { stats.missing++; continue; }
      const key = `${record.sessionRef}:${record.path}`;
      const current = newest.get(key);
      if (!current || record.at >= current.at) newest.set(key, record);
    }
    acceptedWrites.push(...newest.values());
    stats.writes = acceptedWrites.length; stats.artifacts = artifacts.size;
    return { records: [...acceptedWrites, ...artifacts.values()], stats, invalid, available: activeRoots.length > 0 };
  }
}
