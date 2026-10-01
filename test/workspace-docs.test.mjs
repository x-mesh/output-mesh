import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { ingestFile } from '../lib/collector.mjs';
import { Watcher } from '../lib/watcher.mjs';
import { isWorkspaceDoc, projectWorkspaces } from '../lib/workspace-docs.mjs';
import { overview, timeline } from '../lib/search.mjs';
import { nfc } from '../lib/paths.mjs';

let home;
let store;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'output-mesh-home-'));
  store = new CatalogStore(join(home, 'c.db'));
});
afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const write = (path, body = 'x') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const DAY = 86_400;
const ageBy = (path, days) => {
  const at = Date.now() / 1000 - days * DAY;
  utimesSync(path, at, at);
};
const events = () => store.db.query('SELECT e.kind, e.source, a.file_name FROM artifact_events e JOIN artifacts a ON a.id = e.artifact_id ORDER BY e.id').all();

/** git worktree 하나를 만든다. git 처럼 본 저장소에 목록을 적고, worktree 에는 `.git` 포인터 파일을 둔다. */
const linkWorktree = (main, name, path) => {
  const admin = join(main, '.git', 'worktrees', name);
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, 'gitdir'), `${join(path, '.git')}\n`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, '.git'), `gitdir: ${admin}\n`);
  return path;
};

/** 에이전트가 이 저장소에서 파일 하나를 도구로 썼다 — 그래서 작업공간으로 알려진다. */
async function agentWorkedIn(repo) {
  const touched = write(join(repo, 'src', 'main.rs'), 'fn main() {}');
  store.quietEvents = true;
  await ingestFile(store, touched, { collector: 'codex', provider: 'openai-codex', sessionRef: 's1', workspace: repo });
  store.quietEvents = false;
}

describe('작업공간 문서 판단', () => {
  test.each([
    ['README.md', true],
    ['docs/guide.md', true],
    ['site/index.html', true],
    ['assets/shot.png', true],
    ['report.xlsx', true],
    ['src/app.js', false],
    ['package.json', false],
    ['node_modules/pkg/README.md', false],
    ['target/doc/index.html', false],
    ['.xm/plan/notes.md', false],
    ['.claude/plans/a.md', false],
    ['docs/.draft.md', false],
    ['a/b/c/d/e/f/g/h/i/deep.md', false],
  ])('%s → %s', (path, expected) => expect(isWorkspaceDoc(path)).toBe(expected));
});

describe('훑을 작업공간', () => {
  test('홈 밖, 홈 자체, 프로젝트 표지가 없는 곳은 빼고 중첩은 바깥 하나로', async () => {
    const repo = join(home, 'repo');
    const nested = join(repo, 'sub');
    const plain = join(home, 'plain');
    write(join(repo, 'package.json'), '{}');
    write(join(nested, 'package.json'), '{}');
    mkdirSync(plain, { recursive: true });
    for (const workspace of [repo, nested, plain, home, '/tmp']) {
      await ingestFile(store, write(join(home, 'seed', `${workspace.length}.md`)), { collector: 'codex', sessionRef: workspace, workspace });
    }
    expect(projectWorkspaces(store, home)).toEqual([repo]);
  });

  test('세션이 돈 저장소의 worktree 도 훑는다 — 점 폴더 안의 worktree 는 바깥을 훑어도 안 훑이므로 따로', async () => {
    const main = join(home, 'proj');
    mkdirSync(join(main, '.git'), { recursive: true });
    const outside = linkWorktree(main, 'feat', join(home, '.gk', 'worktree', 'proj', 'feat'));
    const inside = linkWorktree(main, 'agent', join(main, '.claude', 'worktrees', 'agent'));
    // 저장소의 하위 폴더에서 돈 세션은 그 폴더만 일한 곳이다. 저장소의 worktree 로 넓히지 않는다.
    const mono = join(home, 'mono');
    mkdirSync(join(mono, '.git'), { recursive: true });
    const sub = join(mono, 'packages', 'app');
    write(join(sub, 'package.json'), '{}');
    linkWorktree(mono, 'x', join(home, '.gk', 'worktree', 'mono', 'x'));
    for (const workspace of [main, sub]) {
      await ingestFile(store, write(join(home, 'seed', `${workspace.length}.md`)), { collector: 'codex', sessionRef: workspace, workspace });
    }
    expect(projectWorkspaces(store, home)).toEqual([main, inside, outside, sub].sort());
  });
});

describe('워처의 작업공간 문서', () => {
  test('worktree 는 만든 뒤에 고친 문서만 처음에 넣는다 — 체크아웃한 본 저장소 문서의 사본은 받지 않는다', async () => {
    const main = join(home, 'repo');
    mkdirSync(join(main, '.git'), { recursive: true });
    await agentWorkedIn(main);
    const wt = linkWorktree(main, 'feat', join(home, '.gk', 'worktree', 'repo', 'feat'));
    const createdAt = Date.now() / 1000 - DAY;
    utimesSync(join(wt, '.git'), createdAt, createdAt);
    const checkedOut = write(join(wt, 'README.md'), '# 사본');
    utimesSync(checkedOut, createdAt, createdAt);
    const edited = write(join(wt, 'CHANGELOG.md'), '# 셸로 고친 문서');

    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home });
    await watcher.collect();

    expect(store.byPathKey(nfc(checkedOut))).toBeNull();
    const row = store.byPathKey(nfc(edited));
    expect(store.originsOf(row.id).map((o) => [o.collector, o.workspace])).toEqual([['workspace', wt]]);
    watcher.stop();
  });

  test('처음에는 최근 문서만 조용히 넣는다 — 원래 있던 문서를 알게 된 것이지 방금 일어난 일이 아니다', async () => {
    const repo = join(home, 'repo');
    write(join(repo, 'package.json'), '{}');
    await agentWorkedIn(repo);
    const recent = write(join(repo, 'README.md'), '# 최근 문서');
    const old = write(join(repo, 'docs', 'old.md'), '# 오래된 문서');
    ageBy(old, 30);
    write(join(repo, 'node_modules', 'dep', 'README.md'), '# 의존성');
    write(join(repo, 'src', 'app.js'), 'x');

    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home });
    await watcher.collect();

    const row = store.byPathKey(nfc(recent));
    expect(row).toBeTruthy();
    expect(store.byPathKey(nfc(old))).toBeNull();
    expect(store.db.query("SELECT COUNT(*) AS n FROM artifacts WHERE file_name = 'app.js'").get().n).toBe(0);
    expect(store.originsOf(row.id).map((o) => [o.collector, o.provider, o.session_ref, o.workspace])).toEqual([['workspace', null, '', repo]]);
    expect(events()).toEqual([]);
    watcher.stop();
  });

  test('감시가 알려 온 문서는 디스크에서 발견한 변화로 기록한다', async () => {
    const repo = join(home, 'repo');
    write(join(repo, 'package.json'), '{}');
    await agentWorkedIn(repo);
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home });
    await watcher.collect();

    const doc = write(join(repo, 'CHANGELOG.md'), '# 0.1.0');
    watcher.noteWorkspaceChange(repo, doc);
    watcher.noteWorkspaceChange(repo, write(join(repo, 'src', 'lib.rs'), 'x'));
    await watcher.collect();
    watcher.stop();

    expect(events()).toEqual([{ kind: 'created', source: 'disk', file_name: 'CHANGELOG.md' }]);
  });

  test('에이전트가 쓴 문서에는 저장소 출처를 더하지 않는다 — 대표 출처가 에이전트로 남는다', async () => {
    const repo = join(home, 'repo');
    write(join(repo, 'package.json'), '{}');
    await agentWorkedIn(repo);
    const doc = write(join(repo, 'PLAN.md'), '# 계획');
    store.quietEvents = true;
    await ingestFile(store, doc, { collector: 'claude', provider: 'anthropic-claude-code', sessionRef: 's2', workspace: repo });
    store.quietEvents = false;
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home });
    await watcher.collect();

    write(doc, '# 계획 v2');
    watcher.noteWorkspaceChange(repo, doc);
    await watcher.collect();
    watcher.stop();

    const row = store.byPathKey(nfc(doc));
    expect(store.originsOf(row.id).map((o) => o.collector)).toEqual(['claude']);
    expect(events()).toEqual([{ kind: 'modified', source: 'disk', file_name: 'PLAN.md' }]);
  });

  test('저장소에서 찾은 문서는 에이전트가 쓴 것으로 세지 않는다 — 그래프와 24시간 작업 수', async () => {
    const repo = join(home, 'repo');
    write(join(repo, 'package.json'), '{}');
    write(join(repo, 'README.md'), '# 문서');
    await ingestFile(store, join(repo, 'README.md'), { collector: 'workspace', sessionRef: '', workspace: repo, createdAt: Math.floor(Date.now() / 1000) });

    expect(timeline(store, '', { view: 'library' }, 'today').providers).toEqual([]);
    expect(overview(store).activeConversations).toBe(0);
  });

  test('가져온 파일의 변경도 에이전트로 적지 않는다', async () => {
    const path = write(join(home, 'imported.md'), '# 가져옴');
    await ingestFile(store, path, { collector: 'import', sessionRef: '' });
    expect(events()).toEqual([{ kind: 'created', source: 'disk', file_name: 'imported.md' }]);
  });
});
