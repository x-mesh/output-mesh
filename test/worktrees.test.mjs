import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace } from '../lib/worktrees.mjs';
import { CatalogStore } from '../lib/store.mjs';
import { Watcher } from '../lib/watcher.mjs';

let home;
beforeEach(() => {
  // macOS 의 tmpdir 은 /var → /private/var 심볼릭 링크다. 경로 비교가 흔들리지 않게 푼다.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a-out-worktrees-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const repo = (path) => {
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
};
const worktree = (path, gitdir) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, '.git'), `gitdir: ${gitdir}\n`);
  return path;
};

describe('작업공간의 저장소 찾기', () => {
  test('보통 저장소는 자기 자신이다', () => {
    const main = repo(join(home, 'work/term-mesh'));
    expect(resolveWorkspace(main, home)).toEqual({ top: main, root: main });
  });

  test('worktree 는 본 저장소로 접는다 — 저장소 하나가 작업공간 네 곳으로 갈라지던 실패', () => {
    const main = repo(join(home, 'work/term-mesh'));
    const wt = worktree(join(home, '.gk/worktree/term-mesh/feat/sync'), join(main, '.git/worktrees/sync'));
    expect(resolveWorkspace(wt, home)).toEqual({ top: wt, root: main });
  });

  test('본 저장소 안에 든 worktree 도 자기 꼭대기를 갖는다', () => {
    const main = repo(join(home, 'work/term-mesh'));
    const wt = worktree(join(main, '.claude/worktrees/latency'), join(main, '.git/worktrees/latency'));
    expect(resolveWorkspace(wt, home)).toEqual({ top: wt, root: main });
  });

  test('상대 경로 gitdir 은 포인터가 놓인 폴더 기준이다', () => {
    const main = repo(join(home, 'work/app'));
    const wt = worktree(join(home, 'work/app-wt'), '../app/.git/worktrees/app-wt');
    expect(resolveWorkspace(wt, home)).toEqual({ top: wt, root: main });
  });

  test('저장소의 하위 폴더에서 돈 세션은 그 저장소다', () => {
    const main = repo(join(home, 'work/term-mesh'));
    mkdirSync(join(main, 'daemon/src'), { recursive: true });
    expect(resolveWorkspace(join(main, 'daemon/src'), home)).toEqual({ top: main, root: main });
  });

  test('worktree 의 하위 폴더도 본 저장소로 간다', () => {
    const main = repo(join(home, 'work/term-mesh'));
    const wt = worktree(join(home, '.gk/worktree/term-mesh/fix'), join(main, '.git/worktrees/fix'));
    mkdirSync(join(wt, 'docs'), { recursive: true });
    expect(resolveWorkspace(join(wt, 'docs'), home)).toEqual({ top: wt, root: main });
  });

  test('서브모듈의 포인터는 worktree 가 아니다 — 자기 자신으로 남는다', () => {
    const sub = worktree(join(home, 'work/app/vendor/lib'), '../../.git/modules/lib');
    expect(resolveWorkspace(sub, home)).toEqual({ top: sub, root: sub });
  });

  test('저장소가 아니거나 이미 없는 폴더는 접지 않는다', () => {
    const plain = join(home, 'work/playground');
    mkdirSync(plain, { recursive: true });
    expect(resolveWorkspace(plain, home)).toEqual({ top: plain, root: plain });
    const gone = join(home, 'work/removed-worktree');
    expect(resolveWorkspace(gone, home)).toEqual({ top: gone, root: gone });
  });

  test('홈의 .git 으로는 올라가지 않는다 — dotfiles 저장소가 모든 폴더를 삼킨다', () => {
    repo(home);
    const plain = join(home, 'work/playground');
    mkdirSync(plain, { recursive: true });
    expect(resolveWorkspace(plain, home)).toEqual({ top: plain, root: plain });
    // 세션이 홈에서 직접 돌았으면 홈이 그 저장소다.
    expect(resolveWorkspace(home, home)).toEqual({ top: home, root: home });
  });

  test('gitdir 줄이 없는 .git 파일은 그냥 그 폴더다', () => {
    const odd = join(home, 'work/odd');
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, '.git'), 'not a pointer');
    expect(resolveWorkspace(odd, home)).toEqual({ top: odd, root: odd });
  });
});

describe('워처가 작업공간의 저장소를 찾아 둔다', () => {
  let store;
  beforeEach(() => {
    store = new CatalogStore(join(home, 'c.db'));
  });
  afterEach(() => store.close());

  const origin = (workspace, sessionRef) => {
    const id = store.insertArtifact({ pathKey: `${workspace}/a.md`, absPath: `${workspace}/a.md`, fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: workspace, fileId: null, mtime: 1 });
    store.recordOrigin(id, { collector: 'codex', provider: 'openai-codex', sessionRef, workspace });
  };
  const roots = () => Object.fromEntries(store.db.query('SELECT workspace, root FROM workspace_roots').all().map((r) => [r.workspace, r.root]));

  test('첫 수집은 전부, 그 뒤로는 처음 보는 작업공간만 본다', async () => {
    const main = repo(join(home, 'work/app'));
    const wt = worktree(join(home, 'wt/app-fix'), join(main, '.git/worktrees/app-fix'));
    origin(main, 's1');
    origin(wt, 's2');
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home });

    await watcher.collect();
    expect(roots()).toEqual({ [main]: main, [wt]: main });

    const later = worktree(join(home, 'wt/app-next'), join(main, '.git/worktrees/app-next'));
    origin(later, 's3');
    expect(watcher.syncWorkspaceRoots()).toBe(1);
    expect(roots()[later]).toBe(main);
  });

  test('지워진 worktree 의 저장소를 자기 자신으로 덮어쓰지 않는다 — 재시작마다 다시 갈라진다', async () => {
    const main = repo(join(home, 'work/app'));
    const wt = worktree(join(home, 'wt/app-fix'), join(main, '.git/worktrees/app-fix'));
    origin(wt, 's1');
    await new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home }).collect();
    rmSync(wt, { recursive: true, force: true });

    await new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home }).collect();
    expect(roots()[wt]).toBe(main);
  });
});
