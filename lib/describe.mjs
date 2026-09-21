import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { cleanTitle } from './extract.mjs';
import { MIN_TASK_CHARS, nfc } from './paths.mjs';

/**
 * 라이브러리 행이 파일명 밑에 보여줄 두 줄: "무엇인가"와 "어디서". 이름이 겹치는 파일이
 * 44%다(SKILL.md 19개, README.md 15개). 파일시스템을 만지지 않는다 — 실제 값을 픽스처로
 * 박아 규칙을 시험할 수 있게. 아래 목록은 표시만 바꾼다: 틀려도 부제가 한 단계 내려갈 뿐
 * 저장된 데이터는 그대로다.
 */

// 제 이름을 되풀이하는 제목. 실측에서 겹치는 이름들의 첫 제목이 이랬다(`# Product` …).
const GENERIC_TITLES = new Set([
  'product', 'readme', 'changelog', 'design', 'claude', 'agents', 'license', 'contributing',
  'todo', 'todos', 'notes', 'index', 'plan', 'skill', 'overview', 'docs', 'home', 'untitled',
]);

// 무엇을 시켰는지가 아니라 이어가라는 말. 짧은 것은 MIN_TASK_CHARS 가 이미 거른다.
const CONTINUATIONS = new Set(['continue', '계속 진행해', '계속 진행해줘', '이어서 진행해', '이어서 해줘']);

// 명령·경로·주소·붙여넣은 도구 출력·주입된 태그로 시작하는 첫 메시지.
const NOISE_PREFIXES = ['$', '❯', '/', './', '~/', 'http://', 'https://', '•', '⏺', '<'];

// 사람이 친 말이 아니라 도구가 끼워 넣은 첫 메시지. 스킬을 부르면 Claude Code 가 이 문장으로 시작하고,
// 팀 훅은 끝낼 때 돌릴 명령을 대괄호 머리말로 주입한다. 실측에서 부제와 활동 제목으로 샜다.
const INJECTED = [/^invoke the \S+ skill\b/i, /^\[REQUIRED FINAL STEP\b/];

// 붙인 그림의 자리 표시. 뒤에 사람이 친 말이 이어지므로 버리지 않고 벗긴다.
const IMAGE_MARKS = /^(?:\[Image #\d+\]\s*)+/;
// 첫 마디가 붙여넣은 경로면 파일 이름만 남긴다. 실측: "/Users/…/rca-ux-patches.md 확인하고, 개선해야할지
// 확인해봐" 가 경로로 시작한다는 이유로 통째로 잡음이 됐고, 활동 제목은 잘린 경로였다(28행).
// 슬래시 커맨드(/clear, /xm:mutate)는 마디가 하나라 걸리지 않는다.
const LEADING_PATH = /^(?:~|\.{1,2})?(?:\/[^/\s]+){2,}(?=\s+\S)/;
const spoken = (task) => nfc(String(task ?? '')).trim().replace(IMAGE_MARKS, '').replace(LEADING_PATH, (path) => basename(path));

const squash = (text) => nfc(String(text)).toLowerCase().replace(/[\s._#-]+/g, '');

export function isInformativeTitle(title, fileName = '') {
  const key = title ? squash(title) : '';
  if (!key || GENERIC_TITLES.has(key)) return false;
  const name = nfc(fileName);
  const echoes = [name, name.replace(/\.[^.]+$/, ''), name.split('.')[0]].map(squash);
  return !echoes.includes(key);
}

export function isInformativeTask(task) {
  const text = spoken(task);
  if (text.length < MIN_TASK_CHARS) return false;
  if (CONTINUATIONS.has(text.toLowerCase().replace(/[\s.!?~]+$/, ''))) return false;
  if (INJECTED.some((pattern) => pattern.test(text))) return false;
  return !NOISE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** 첫 발화에서 작업 제목을 고른다. 첫 줄이 주소나 명령이면 그 아래의 쓸 만한 첫 줄이다. */
export function titleFromPrompt(prompt, maxChars) {
  const lines = String(prompt ?? '').split('\n').map(spoken).filter(Boolean);
  const line = lines.find(isInformativeTask) ?? lines[0];
  return line ? line.slice(0, maxChars) : null;
}

/**
 * 활동 보기의 제목. 저장된 제목이 도구가 끼워 넣은 문구면 비운다 — 출처는 새 제목이 없을 때 옛 제목을
 * 지키므로(COALESCE) 로그를 다시 읽어도 그런 제목이 남는다. 부제와 달리 짧은 말은 남긴다: "계속"도
 * 사람이 친 말이고, 가리면 "제목 없는 작업"만 는다.
 */
export function sessionTitleOf(stored) {
  const text = spoken(stored);
  if (!text || text.startsWith('<') || INJECTED.some((pattern) => pattern.test(text))) return null;
  return text;
}

const isWithin = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * 파일이 놓인 곳. 작업공간 안이면 저장소 이름과 저장소 안 경로를, 밖이면 실제 경로를 준다 —
 * 세션이 x-kit 에서 돌며 ~/.codex/skills 를 고친 경우 x-kit 안인 척하면 틀린 말이다.
 * 작업공간이 아예 없으면(Aside·가져옴) null: 화면이 수집기 이름을 대신 쓴다.
 *
 * 작업공간은 경로이거나 { top, root } 다. 파일이 안에 있는지는 그 체크아웃의 꼭대기(top)로 보고,
 * 이름은 본 저장소(root)에서 빌린다 — git worktree 의 파일이 본 저장소 아래에 worktree 이름과 함께 선다.
 */
export function locationOf(absPath, workspaces = [], home = homedir()) {
  if (!absPath) return null;
  const parent = dirname(nfc(absPath));
  const checkouts = workspaces.filter(Boolean)
    .map((entry) => (typeof entry === 'string' ? { top: entry, root: entry } : entry))
    .map(({ top, root }) => ({ top: nfc(top), root: nfc(root) }));
  // 중첩된 저장소는 가장 안쪽이 파일의 저장소다. 본 저장소 안에 든 worktree 도 그렇게 제 이름을 얻는다.
  const inside = checkouts.filter(({ top }) => isWithin(top, parent)).sort((a, b) => b.top.length - a.top.length)[0];
  if (inside) {
    const rel = relative(inside.top, parent);
    const where = { repo: basename(inside.root), dir: rel ? `${rel}/` : '/' };
    return inside.top === inside.root ? where : { ...where, worktree: basename(inside.top) };
  }
  if (checkouts.length === 0) return null;
  const inHome = isWithin(home, parent);
  const shown = inHome ? `~/${relative(home, parent)}` : parent;
  return { repo: null, dir: `${shown.replace(/\/$/, '')}/` };
}

/**
 * tasks 는 루트 스레드 먼저, 이른 순이다. 파일이 왜 존재하는지는 처음 만든 작업이 가장 잘
 * 말하고, 서브에이전트 스레드의 제목은 그 스레드가 받은 지시일 뿐이다.
 */
export function describe({ title = null, fileName = '', tasks = [], workspaces = [], absPath = null, home = homedir() }) {
  const task = tasks.find(isInformativeTask);
  const location = locationOf(absPath, workspaces, home);
  // README 의 제목이 저장소 이름뿐이면(실측 15개) 바로 옆의 위치가 이미 같은 말을 한다.
  const echoesRepo = Boolean(title && location?.repo) && squash(title) === squash(location.repo);
  const docTitle = isInformativeTitle(title, fileName) && !echoesRepo ? title : null;
  const taskTitle = task ? cleanTitle(spoken(task)) : null;
  return {
    subtitle: docTitle ?? taskTitle,
    subtitle_source: docTitle ? 'doc' : taskTitle ? 'task' : null,
    location,
  };
}
