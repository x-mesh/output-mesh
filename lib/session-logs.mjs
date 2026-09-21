import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { LOG_READ_CHUNK_BYTES } from './paths.mjs';

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
 *
 * 수집이 쓰기를 흘렸을 때도 올린다. 4: 폴더 경로 하나에 배치가 EISDIR 로 죽어 그 뒤의 쓰기가
 * 버려졌고, 커서는 다음 성공 때 그 로그들을 지나갔다. 다시 읽어야 되찾는다.
 * 5: Codex 패치 경로가 작은따옴표 · 백틱에서 끝난다. 잘못 끊겨 없는 파일로 버려지던 쓰기가 돌아온다.
 */
export const SESSION_LOG_PARSER_VERSION = 5;

/**
 * 경로는 첫 역슬래시·따옴표·줄바꿈에서 끝난다. 요즘 Codex 는 apply_patch 를 exec 도구의
 * JS 문자열 안에 넣어 보내서 줄바꿈이 한 번 더 이스케이프돼(`\\n`) 저장된다. 줄바꿈 두 글자만
 * 종결자로 보면 앞의 역슬래시가 경로 끝에 붙어 `a.swift\` 가 되고, 파일이 없는 것으로 판정돼
 * 버려진다 — 실측 214개 세션이 통째로 사라졌다. macOS 경로에 역슬래시가 들어간 사례는 0건이다.
 * `Move to:` 는 이름을 바꾼 패치의 새 경로다. 옛 경로는 더는 없으므로 새 경로를 잡는다.
 */
// 경로는 줄 끝이나 문자열의 끝에서 끝난다. 에이전트가 패치를 코드 안의 문자열로 조립하면
// (['*** Update File: a.mjs','@@', …], String.raw`…`) 작은따옴표와 백틱이 그 끝이다. 큰따옴표와
// 역슬래시만 보던 때는 패치 본문까지 경로가 됐다(실측 90건, stat 이 ENAMETOOLONG 을 던진다).
const CODEX_PATCH = /\*\*\* (?:Add File|Update File|Move to): ([^\\"'`\r\n]+)/g;
const CODEX_MARKERS = ['*** Add File:', '*** Update File:', '*** Move to:'];
const CLAUDE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// JSON.parse 전에 거르는 표시. 대부분의 줄(도구 출력, 추론)은 쓴 경로도 발화도 아니다.
const USER_LINE = /"role":\s?"user"/;
const TOOL_USE_LINE = /"type":\s?"tool_use"/;
const SESSION_META_LINE = /"type":\s?"session_meta"/;

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
  // 활동 제목으로 샌 것들(실측 29 · 2 · 17행): Codex 의 환경 덤프, 스킬을 부를 때 Claude Code 가 쓰는 첫 문장,
  // 팀 훅이 끝낼 때 돌릴 명령을 주입하는 머리말.
  '<environment_context>', 'skill to handle this request', '[REQUIRED FINAL STEP',
];

/** 슬래시 커맨드 래퍼와 선행 지시문을 벗겨 사람이 친 말만 남긴다. */
const PROMPT_PREFIXES = [/^User provided:\s*/, /^\s*<command-args>\s*/];

export function looksLikePrompt(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > MAX_PROMPT_CHARS) return false;
  return !PREAMBLE_MARKERS.some((marker) => trimmed.includes(marker));
}

/** 사람이 친 말이면 래퍼를 벗겨 돌려주고, 아니면 null. */
function promptOf(text) {
  if (!looksLikePrompt(text)) return null;
  let cleaned = text.trim();
  for (const prefix of PROMPT_PREFIXES) cleaned = cleaned.replace(prefix, '');
  return cleaned.trim() || null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && (block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
}

// Claude Code 가 세션마다 두는 임시 폴더(`/private/tmp/claude-501/<프로젝트>/<세션>/scratchpad/`). 세션이
// 끝나면 버려지는 자리라, 넣으면 피드 맨 위를 차지했다가 곧 "원본 없음"이 된다. 임시 폴더 전체를
// 거르지는 않는다 — 실측된 잡음은 이것뿐이고, 사람이 /tmp 에서 에이전트를 돌리는 일도 있다.
const AGENT_SCRATCH = /^\/(?:private\/)?tmp\/claude-[^/]+\//;

export function isIndexablePath(path) {
  if (!isAbsolute(path)) return false;
  if (AGENT_SCRATCH.test(path)) return false;
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
 * 로그를 어디까지 읽었나. 에이전트가 도는 동안 로그는 몇 초마다 자란다 — 통째로 다시 읽으면
 * 31MB 로그 하나가 수집마다 수십 MB 를 할당해 서버 메모리가 30초에 66MB 씩 불었다.
 * 로그는 덧붙이기만 하므로 읽은 바이트 뒤부터 이어 읽고, 앞부분에서 알아낸 세션 정보는 state 에 둔다.
 */
export function newLogTail() {
  return { ino: null, offset: 0, state: null };
}

/** 파일이 바뀌었거나(다른 inode) 줄었으면 처음부터 다시 읽는다. */
function resumeTail(logPath, tail) {
  const stat = statSync(logPath);
  if (tail.ino !== stat.ino || stat.size < tail.offset) Object.assign(tail, { ino: stat.ino, offset: 0, state: null });
  return stat;
}

/**
 * tail.offset 부터 끝까지 완성된 줄만 돌려준다. 끝에 줄바꿈 없이 남은 조각은 쓰는 중일 수 있어
 * JSON 으로 완성됐을 때만 받는다. 줄바꿈(0x0A)은 UTF-8 다중 바이트 안에 나오지 않으므로 바이트로 자른다.
 */
function* newLines(logPath, tail, size) {
  const fd = openSync(logPath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(Math.min(LOG_READ_CHUNK_BYTES, Math.max(1, size - tail.offset)));
    let position = tail.offset;
    let carry = Buffer.alloc(0);
    while (position < size) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (read === 0) break;
      position += read;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const end = data.lastIndexOf(0x0a);
      if (end === -1) {
        carry = Buffer.from(data);
        continue;
      }
      const text = data.toString('utf8', 0, end);
      carry = Buffer.from(data.subarray(end + 1));
      yield* text.split('\n');
      tail.offset = position - carry.length;
    }
    if (carry.length === 0) return;
    const last = carry.toString('utf8');
    try {
      JSON.parse(last);
    } catch {
      return; // 아직 쓰는 중인 줄. 다음 수집에서 이어 읽는다
    }
    yield last;
    tail.offset = position;
  } finally {
    closeSync(fd);
  }
}

/**
 * Codex 는 산출물 레코드를 남기지 않는다. 대신 apply_patch 본문의
 * `*** Add/Update File:` 마커가 쓴 경로를 그대로 담고 있다.
 */
export function codexWrites(logPath, tail = newLogTail()) {
  const { size, mtimeMs } = resumeTail(logPath, tail);
  const session = (tail.state ??= { cwd: null, threadId: null, conversationId: null, firstPrompt: null, lastPrompt: null });
  const latest = new Map();
  const fallbackAt = Math.floor(mtimeMs / 1000);

  for (const line of newLines(logPath, tail, size)) {
    if (!line.startsWith('{')) continue;
    const marked = CODEX_MARKERS.some((marker) => line.includes(marker));
    if (!marked && !USER_LINE.test(line) && !SESSION_META_LINE.test(line)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 한 줄이 깨져도 나머지 패치는 여전히 유효하다
    }
    const payload = entry.payload ?? {};
    if (entry.type === 'session_meta') {
      session.cwd ??= payload.cwd ?? null;
      session.threadId ??= payload.id ?? null;
      // 서브에이전트 스레드도 같은 session_id 를 가진다. 없으면 옛 로그라 스레드가 곧 대화다.
      session.conversationId ??= payload.session_id ?? payload.id ?? null;
    }
    if (payload.role === 'user') {
      const prompt = promptOf(textOf(payload.content));
      if (prompt) {
        session.firstPrompt ??= prompt;
        session.lastPrompt = prompt;
      }
    }
    if (!marked) continue;
    const { cwd } = session;

    // 쓰기마다 그 줄의 시각을 쓴다. 세션 시작 시각을 쓰면 오래 도는 세션이 지금 쓰고
    // 있어도 과거 작업처럼 정렬된다.
    const at = entry.timestamp ? Math.floor(Date.parse(entry.timestamp) / 1000) : fallbackAt;
    for (const [, captured] of line.matchAll(CODEX_PATCH)) {
      const cleaned = captured.trim();
      // 템플릿의 빈칸(`${current}`)은 경로가 아니고, `/` 로 끝나거나 cwd 자신인 것은 파일이 아니라 폴더다.
      if (!cleaned || cleaned.includes('${') || cleaned.endsWith('/')) continue;
      const absolute = isAbsolute(cleaned) ? cleaned : cwd ? resolve(cwd, cleaned) : null;
      if (!absolute || absolute === cwd || !isIndexablePath(absolute)) continue;
      latest.set(absolute, Math.max(latest.get(absolute) ?? 0, at));
    }
  }

  // 서브에이전트·재개 스레드의 로그 앞부분은 부모 대화의 역사를 다시 담은 것이라 첫 발화가
  // 옛 질문으로 고정된다. 루트 스레드는 첫 발화가 대화의 과제이고, 나머지 스레드는 끝 발화가
  // 그 스레드가 실제로 받은 지시다.
  const { threadId, conversationId } = session;
  const isRoot = !conversationId || conversationId === threadId;
  const prompt = isRoot ? session.firstPrompt : session.lastPrompt;
  return [...latest].map(([path, at]) => ({
    path, sessionRef: threadId, conversationRef: conversationId, isRoot, workspace: session.cwd, at, prompt,
  }));
}

/** Claude Code transcript 는 tool_use 블록에 file_path 를 구조적으로 남긴다. */
export function claudeWrites(logPath, tail = newLogTail()) {
  const { size } = resumeTail(logPath, tail);
  const session = (tail.state ??= { sessionRef: null, cwd: null, prompt: null });
  const out = new Map();

  for (const line of newLines(logPath, tail, size)) {
    if (!line.startsWith('{')) continue;
    // 세션 정보는 아무 줄에나 있다. 첫 발화를 찾은 뒤로는 쓴 경로가 있을 수 있는 줄만 푼다.
    const needed = session.sessionRef === null || TOOL_USE_LINE.test(line) || (session.prompt === null && USER_LINE.test(line));
    if (!needed) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    session.sessionRef ??= entry.sessionId ?? null;
    session.cwd ??= entry.cwd ?? null;
    const { sessionRef, cwd } = session;

    if (entry.message?.role === 'user') session.prompt ??= promptOf(textOf(entry.message.content));

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
  return [...out.values()].map((write) => ({ ...write, prompt: session.prompt }));
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
