import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { nfc } from './paths.mjs';

/**
 * 세션이 돈 폴더(cwd)가 어느 저장소의 것인가. 실측에서 작업공간 44곳 중 18곳이 git worktree 라
 * (`~/.gk/worktree/…`, `<저장소>/.claude/worktrees/…`) 저장소 하나가 트리와 작업공간 분포에서
 * 네 군데로 갈라졌다. 저장소의 하위 폴더에서 돈 세션도 같은 방식으로 제 저장소를 찾는다.
 *
 * 읽기만 한다. worktree 의 `.git` 은 폴더가 아니라 `gitdir: <본 저장소>/.git/worktrees/<이름>`
 * 한 줄이 든 파일이다.
 */

const WORKTREE_MARK = `${sep}.git${sep}worktrees${sep}`;
const GITDIR_LINE = /^gitdir:\s*(.+)$/m;
// 포인터 파일은 한 줄이다. 이름만 `.git` 인 큰 파일을 통째로 읽지 않는다.
const MAX_POINTER_BYTES = 4096;

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** `.git` 포인터가 worktree 를 가리키면 본 저장소 경로, 아니면(서브모듈 등) null. */
function mainRepoOf(top, pointerPath, size) {
  if (size > MAX_POINTER_BYTES) return null;
  let text;
  try {
    text = readFileSync(pointerPath, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(GITDIR_LINE);
  if (!match) return null;
  const gitdir = resolve(top, match[1].trim());
  const at = gitdir.indexOf(WORKTREE_MARK);
  return at > 0 ? gitdir.slice(0, at) : null;
}

const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * top 은 `.git` 이 있는 가장 가까운 상위 폴더(그 체크아웃의 꼭대기), root 는 worktree 일 때의
 * 본 저장소다. 저장소가 아니거나 폴더가 이미 없으면 둘 다 workspace 그대로 — 접지 않는다.
 *
 * 위로 올라갈 때 홈과 그 위의 `.git` 은 받지 않는다. 홈에 dotfiles 저장소를 둔 머신에서는
 * 저장소가 아닌 모든 폴더가 홈 하나로 접힌다.
 */
export function resolveWorkspace(workspace, home = homedir()) {
  const start = nfc(workspace);
  const self = { top: start, root: start };
  if (!isAbsolute(start)) return self;

  for (let dir = start; ; dir = dirname(dir)) {
    // 홈이거나 홈의 조상(`/` 포함)인 상위 폴더에서 멈춘다. 세션이 돈 폴더 자신은 어디든 받는다.
    if (dir !== start && (dir === home || isInside(dir, home))) return self;
    const pointerPath = join(dir, '.git');
    const stat = statOrNull(pointerPath);
    if (stat?.isDirectory()) return { top: dir, root: dir };
    if (stat?.isFile()) return { top: dir, root: mainRepoOf(dir, pointerPath, stat.size) ?? dir };
    if (dir === dirname(dir)) return self;
  }
}
