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

const squash = (text) => nfc(String(text)).toLowerCase().replace(/[\s._#-]+/g, '');

export function isInformativeTitle(title, fileName = '') {
  const key = title ? squash(title) : '';
  if (!key || GENERIC_TITLES.has(key)) return false;
  const name = nfc(fileName);
  const echoes = [name, name.replace(/\.[^.]+$/, ''), name.split('.')[0]].map(squash);
  return !echoes.includes(key);
}

export function isInformativeTask(task) {
  const text = nfc(String(task ?? '')).trim();
  if (text.length < MIN_TASK_CHARS) return false;
  if (CONTINUATIONS.has(text.toLowerCase().replace(/[\s.!?~]+$/, ''))) return false;
  return !NOISE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

const isWithin = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * 파일이 놓인 곳. 작업공간 안이면 저장소 이름과 저장소 안 경로를, 밖이면 실제 경로를 준다 —
 * 세션이 x-kit 에서 돌며 ~/.codex/skills 를 고친 경우 x-kit 안인 척하면 틀린 말이다.
 * 작업공간이 아예 없으면(Aside·가져옴) null: 화면이 수집기 이름을 대신 쓴다.
 */
export function locationOf(absPath, workspaces = [], home = homedir()) {
  if (!absPath) return null;
  const parent = dirname(nfc(absPath));
  const roots = workspaces.filter(Boolean).map(nfc);
  // 중첩된 저장소는 가장 안쪽이 파일의 저장소다.
  const repo = roots.filter((root) => isWithin(root, parent)).sort((a, b) => b.length - a.length)[0];
  if (repo) {
    const rel = relative(repo, parent);
    return { repo: basename(repo), dir: rel ? `${rel}/` : '/' };
  }
  if (roots.length === 0) return null;
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
  const docTitle = isInformativeTitle(title, fileName) ? title : null;
  const taskTitle = task ? cleanTitle(task) : null;
  return {
    subtitle: docTitle ?? taskTitle,
    subtitle_source: docTitle ? 'doc' : taskTitle ? 'task' : null,
    location: locationOf(absPath, workspaces, home),
  };
}
