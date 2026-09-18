import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const CODEX_SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');
export const CLAUDE_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/** 저장소 안 생성물을 찾는 것이므로 빌드 산출물과 의존성 트리는 제외한다. */
const SKIP_SEGMENTS = new Set([
  '.git', 'node_modules', 'target', 'dist', 'build', '.build', '.next',
  '__pycache__', '.venv', 'venv', 'vendor', 'coverage', '.cache',
]);

/**
 * 세션 로그 파서를 고치면 올린다. 수집 커서는 이미 지나간 로그를 다시 읽지 않으므로,
 * 버전이 바뀌어야 과거 로그가 새 파서로 다시 매겨진다. 잊으면 파서 수정이 기존 세션에
 * 아무 효과도 내지 않는다(분류의 KIND_RULES_VERSION 과 같은 함정).
 */
export const SESSION_LOG_PARSER_VERSION = 3;

/**
 * 경로는 첫 역슬래시·따옴표·줄바꿈에서 끝난다. 요즘 Codex 는 apply_patch 를 exec 도구의
 * JS 문자열 안에 넣어 보내서 줄바꿈이 한 번 더 이스케이프돼(`\\n`) 저장된다. 줄바꿈 두 글자만
 * 종결자로 보면 앞의 역슬래시가 경로 끝에 붙어 `a.swift\` 가 되고, 파일이 없는 것으로 판정돼
 * 버려진다 — 실측 214개 세션이 통째로 사라졌다. macOS 경로에 역슬래시가 들어간 사례는 0건이다.
 * `Move to:` 는 이름을 바꾼 패치의 새 경로다. 옛 경로는 더는 없으므로 새 경로를 잡는다.
 */
const CODEX_PATCH = /\*\*\* (?:Add File|Update File|Move to): ([^\\"\r\n]+)/g;
const CODEX_MARKERS = ['*** Add File:', '*** Update File:', '*** Move to:'];
const CLAUDE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const MAX_PROMPT_CHARS = 2000;

/**
 * 첫 user 메시지는 대개 지침 덤프(AGENTS.md, system-reminder)다. 사람이 실제로 친 말이
 * 나올 때까지 건너뛴다 — 활동 보기에서 "뭘 시켰나"를 읽으려면 이게 맞아야 한다.
 */
const PREAMBLE_MARKERS = [
  'AGENTS.md instructions', '<INSTRUCTIONS>', '<system-reminder>', '<command-name>',
  '# Global instructions', 'Caveat: The messages below',
  '<teammate-message', '<task-notification', '<local-command-stdout', 'Hard deadline reached',
  '<image name=', '<local-command-name', '<user-prompt-submit-hook',
  '<subagent_notification', '<turn_aborted',
];

/** 슬래시 커맨드 래퍼와 선행 지시문을 벗겨 사람이 친 말만 남긴다. */
const PROMPT_PREFIXES = [/^User provided:\s*/, /^\s*<command-args>\s*/];

export function looksLikePrompt(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > MAX_PROMPT_CHARS) return false;
  return !PREAMBLE_MARKERS.some((marker) => trimmed.includes(marker));
}

function lastPrompt(candidates) {
  return firstPrompt([...candidates].reverse());
}

function firstPrompt(candidates) {
  for (const text of candidates) {
    if (!looksLikePrompt(text)) continue;
    let cleaned = text.trim();
    for (const prefix of PROMPT_PREFIXES) cleaned = cleaned.replace(prefix, '');
    cleaned = cleaned.trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && (block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
}

export function isIndexablePath(path) {
  if (!isAbsolute(path)) return false;
  return !path.split('/').some((segment) => SKIP_SEGMENTS.has(segment));
}

function walkFiles(root, suffix, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, suffix, out);
    else if (entry.name.endsWith(suffix)) out.push(path);
  }
  return out;
}

/** mtime 커서보다 새 로그만 돌려준다. 첫 실행 뒤로는 거의 아무것도 읽지 않는다. */
export function logFilesSince(root, suffix, sinceMs) {
  return walkFiles(root, suffix)
    .map((path) => {
      const stat = statSync(path);
      // 크기는 첫 수집의 진행률에 쓴다. 로그는 몇 KB 부터 수백 MB 까지라 개수로 세면 진행률이 널뛴다.
      return { path, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .filter((entry) => entry.mtimeMs > sinceMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Codex 는 산출물 레코드를 남기지 않는다. 대신 apply_patch 본문의
 * `*** Add/Update File:` 마커가 쓴 경로를 그대로 담고 있다.
 */
export function codexWrites(logPath) {
  const raw = readFileSync(logPath, 'utf8');
  if (!CODEX_MARKERS.some((marker) => raw.includes(marker))) return [];

  let cwd = null;
  let threadId = null;
  let conversationId = null;
  const candidates = [];
  const latest = new Map();
  const fallbackAt = Math.floor(statSync(logPath).mtimeMs / 1000);

  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 한 줄이 깨져도 나머지 패치는 여전히 유효하다
    }
    const payload = entry.payload ?? {};
    if (entry.type === 'session_meta') {
      cwd ??= payload.cwd ?? null;
      threadId ??= payload.id ?? null;
      // 서브에이전트 스레드도 같은 session_id 를 가진다. 없으면 옛 로그라 스레드가 곧 대화다.
      conversationId ??= payload.session_id ?? payload.id ?? null;
    }
    if (payload.role === 'user') candidates.push(textOf(payload.content));
    if (!CODEX_MARKERS.some((marker) => line.includes(marker))) continue;

    // 쓰기마다 그 줄의 시각을 쓴다. 세션 시작 시각을 쓰면 오래 도는 세션이 지금 쓰고
    // 있어도 과거 작업처럼 정렬된다.
    const at = entry.timestamp ? Math.floor(Date.parse(entry.timestamp) / 1000) : fallbackAt;
    for (const [, captured] of line.matchAll(CODEX_PATCH)) {
      const cleaned = captured.trim();
      if (!cleaned) continue;
      const absolute = isAbsolute(cleaned) ? cleaned : cwd ? resolve(cwd, cleaned) : null;
      if (!absolute || !isIndexablePath(absolute)) continue;
      latest.set(absolute, Math.max(latest.get(absolute) ?? 0, at));
    }
  }

  // 서브에이전트·재개 스레드의 로그 앞부분은 부모 대화의 역사를 다시 담은 것이라 첫 발화가
  // 옛 질문으로 고정된다. 루트 스레드는 첫 발화가 대화의 과제이고, 나머지 스레드는 끝 발화가
  // 그 스레드가 실제로 받은 지시다.
  const isRoot = !conversationId || conversationId === threadId;
  const prompt = isRoot ? firstPrompt(candidates) : lastPrompt(candidates);
  return [...latest].map(([path, at]) => ({
    path, sessionRef: threadId, conversationRef: conversationId, isRoot, workspace: cwd, at, prompt,
  }));
}

/** Claude Code transcript 는 tool_use 블록에 file_path 를 구조적으로 남긴다. */
export function claudeWrites(logPath) {
  const out = new Map();
  const candidates = [];
  let sessionRef = null;
  let cwd = null;

  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    sessionRef ??= entry.sessionId ?? null;
    cwd ??= entry.cwd ?? null;

    if (entry.message?.role === 'user') candidates.push(textOf(entry.message.content));

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || !CLAUDE_WRITERS.has(block.name)) continue;
      const path = block.input?.file_path ?? block.input?.notebook_path;
      if (!path || !isIndexablePath(path)) continue;
      const at = entry.timestamp ? Math.floor(Date.parse(entry.timestamp) / 1000) : null;
      out.set(path, { path, sessionRef: entry.sessionId ?? sessionRef, workspace: entry.cwd ?? cwd, at });
    }
  }
  const prompt = firstPrompt(candidates);
  return [...out.values()].map((write) => ({ ...write, prompt }));
}

export const SESSION_LOG_SOURCES = [
  {
    collector: 'codex',
    provider: 'openai-codex',
    root: CODEX_SESSIONS_ROOT,
    suffix: '.jsonl',
    cursorKey: 'codex.scanned_until',
    parse: codexWrites,
  },
  {
    collector: 'claude-code',
    provider: 'claude-code',
    root: CLAUDE_PROJECTS_ROOT,
    suffix: '.jsonl',
    cursorKey: 'claude.scanned_until',
    parse: claudeWrites,
  },
];
