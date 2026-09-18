import { afterEach, beforeEach, describe as group, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { indexPending } from '../lib/collector.mjs';
import { Watcher } from '../lib/watcher.mjs';
import { search } from '../lib/search.mjs';
import { EXTRACT_RULES_VERSION, docTitleFrom, extractBody } from '../lib/extract.mjs';
import { describe, isInformativeTask, isInformativeTitle, locationOf } from '../lib/describe.mjs';
import { TITLE_MAX_CHARS } from '../lib/paths.mjs';

let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a-out-describe-'));
  store = new CatalogStore(join(dir, 'c.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

group('문서 제목 — 이름이 같은 파일을 구분하는 첫 재료', () => {
  test('프런트매터의 name 과 description 을 합친다 — SKILL.md 들은 이 조합이 다르다', () => {
    const raw = '---\nname: review\ndescription: Multi-perspective code review\n---\n\n# Review\n';
    expect(docTitleFrom(raw, 'md')).toBe('review — Multi-perspective code review');
  });

  test('블록 스칼라 description 은 들여쓴 줄을 잇는다 — 안 그러면 제목이 `>` 가 된다', () => {
    const raw = '---\nname: plan\ndescription: >\n  Produce an implementation\n  plan from requirements\nother: x\n---\n';
    expect(docTitleFrom(raw, 'md')).toBe('plan — Produce an implementation plan from requirements');
  });

  test('닫히지 않은 프런트매터는 프런트매터가 아니다 — 첫 # 으로 넘어간다', () => {
    const raw = '---\nname: broken\n\n# 진짜 제목\n본문';
    expect(docTitleFrom(raw, 'md')).toBe('진짜 제목');
  });

  test('따옴표·마크다운 장식·엔티티를 벗긴다', () => {
    expect(docTitleFrom('---\nname: "quoted"\n---\n', 'md')).toBe('quoted');
    expect(docTitleFrom('# **굵게** `코드` [링크](https://x) &amp; 끝\n', 'md')).toBe('굵게 코드 링크 & 끝');
  });

  test('코드 블록 안의 셸 주석은 제목이 아니다', () => {
    expect(docTitleFrom('```sh\n# install\nnpm i\n```\n\n## 사용법\n', 'md')).toBe('사용법');
  });

  test('가운데 정렬 README 의 <h1> 이 아래쪽 ## 보다 먼저다', () => {
    const raw = '<p align="center"><img src="logo.png"></p>\n\n<h1 align="center">term-mesh</h1>\n\n## Features\n';
    expect(docTitleFrom(raw, 'md')).toBe('term-mesh');
  });

  test('html 은 <title>, 없으면 <h1>', () => {
    expect(docTitleFrom('<title>탭 제목</title><h1>본문 제목</h1>', 'html')).toBe('탭 제목');
    expect(docTitleFrom('<body><h1>본문 <em>제목</em></h1></body>', 'html')).toBe('본문 제목');
  });

  test('긴 제목은 자른다', () => {
    const title = docTitleFrom(`# ${'가'.repeat(TITLE_MAX_CHARS * 2)}`, 'md');
    expect(title).toHaveLength(TITLE_MAX_CHARS);
    expect(title.endsWith('…')).toBe(true);
  });

  test('제목을 뽑지 않는 형식은 null', async () => {
    const path = join(dir, 'a.txt');
    writeFileSync(path, '# 텍스트 파일의 샵');
    expect((await extractBody(path, 'txt', 'a.txt')).title).toBeNull();
  });
});

group('부제 — 문서 제목, 없으면 만든 작업', () => {
  test('제목이 파일명을 되풀이하거나 일반 명사면 작업으로 내려간다', () => {
    expect(isInformativeTitle('Product', 'PRODUCT.md')).toBe(false);
    expect(isInformativeTitle('README', 'README.ko.md')).toBe(false);
    expect(isInformativeTitle('CLAUDE.md', 'CLAUDE.md')).toBe(false);
    expect(isInformativeTitle('quicsync', 'README.md')).toBe(true);

    const row = describe({ title: 'Product', fileName: 'PRODUCT.md', tasks: ['diagram.io 기반 MCP 를 만들고 싶음'] });
    expect([row.subtitle, row.subtitle_source]).toEqual(['diagram.io 기반 MCP 를 만들고 싶음', 'task']);
  });

  test('이어가기 말·명령·주소·붙여넣은 출력·주입 태그는 작업이 아니다', () => {
    for (const noise of ['계속', '진행해', '수정해봐', 'continue', '❯ /xm:mutate', '$xm-handon', '/clear', 'https://example.com/a', '• Ran tests', '⏺ Bash(ls)', '<environment_context>']) {
      expect([noise, isInformativeTask(noise)]).toEqual([noise, false]);
    }
    expect(isInformativeTask('가계부 앱 데이터 연동 분석 가능성')).toBe(true);
  });

  test('쓸 만한 작업이 없으면 부제를 비운다 — 잡음을 보여주지 않는다', () => {
    expect(describe({ title: null, fileName: 'card', tasks: ['계속', '❯ /x'] }).subtitle).toBeNull();
  });
});

group('위치 — 어디서', () => {
  const home = '/Users/me';
  test('작업공간 안이면 저장소 이름과 저장소 안 경로', () => {
    expect(locationOf('/Users/me/x-kit/xm/skills/review/SKILL.md', ['/Users/me/x-kit'], home)).toEqual({ repo: 'x-kit', dir: 'xm/skills/review/' });
    expect(locationOf('/Users/me/x-kit/README.md', ['/Users/me/x-kit'], home)).toEqual({ repo: 'x-kit', dir: '/' });
  });

  test('중첩된 저장소는 가장 안쪽이 파일의 저장소다', () => {
    expect(locationOf('/Users/me/a/b/doc.md', ['/Users/me/a', '/Users/me/a/b'], home)).toEqual({ repo: 'b', dir: '/' });
  });

  test('파일이 작업공간 밖이면 저장소 안인 척하지 않는다', () => {
    expect(locationOf('/Users/me/.codex/skills/r/SKILL.md', ['/Users/me/x-kit'], home)).toEqual({ repo: null, dir: '~/.codex/skills/r/' });
    // 이름이 겹치는 형제 디렉터리는 안이 아니다.
    expect(locationOf('/Users/me/x-kit-old/a.md', ['/Users/me/x-kit'], home).repo).toBeNull();
  });

  test('작업공간이 없으면 null — 화면이 수집기 이름을 쓴다', () => {
    expect(locationOf('/Users/me/.aside/s/artifacts/a.xlsx', [], home)).toBeNull();
  });
});

group('서버 장식 — 목록 행에 부제와 위치가 실린다', () => {
  function artifact(name, absPath) {
    return store.insertArtifact({ pathKey: absPath, absPath, fileName: name, ext: 'md', sizeBytes: 1, contentHash: absPath, fileId: null, mtime: 1 });
  }

  test('작업은 루트 스레드의 가장 이른 제목이다 — 서브에이전트 지시가 부제가 되지 않는다', () => {
    const id = artifact('notes.md', '/w/repo/docs/notes.md');
    const base = { collector: 'codex', provider: 'openai-codex', workspace: '/w/repo', conversationRef: 'root' };
    store.recordOrigin(id, { ...base, sessionRef: 'sub-1', sessionTitle: 'You are a leaf code reviewer', createdAt: 10 });
    store.recordOrigin(id, { ...base, sessionRef: 'root', sessionTitle: '계속', createdAt: 20 });
    store.recordOrigin(id, { ...base, sessionRef: 'root-later', conversationRef: 'root-later', sessionTitle: '나중에 고친 작업', createdAt: 40 });
    store.recordOrigin(id, { ...base, sessionRef: 'root-first', conversationRef: 'root-first', sessionTitle: '처음 만든 작업입니다', createdAt: 30 });
    store.upsertSearchDoc(id, { name: 'notes.md', path: '/w/repo/docs/notes.md', body: 'x', bodyState: 'indexed', title: 'Notes' });

    const [row] = search(store, '');
    expect(row.subtitle).toBe('처음 만든 작업입니다');
    expect(row.location).toEqual({ repo: 'repo', dir: 'docs/' });
    expect(row).not.toHaveProperty('tasks_json');
  });

  test('행에 모든 출처의 앱 목록이 실린다 — 대표 하나만 실으면 앱별 묶음이 필터와 어긋난다', () => {
    const id = artifact('shared.md', '/w/repo/shared.md');
    store.recordOrigin(id, { collector: 'codex', sessionRef: 'c', provider: 'openai-codex', workspace: '/w/repo' });
    store.recordOrigin(id, { collector: 'aside', sessionRef: 'a', provider: 'claude-code', isDeliverable: true });

    const [row] = search(store, '');
    expect(row.collectors).toEqual(['aside', 'codex']);
    expect(row.providers).toEqual(['claude-code', 'openai-codex']);
  });

  test('문서 제목이 쓸 만하면 작업보다 먼저다', () => {
    const id = artifact('SKILL.md', '/w/kit/skills/review/SKILL.md');
    store.recordOrigin(id, { collector: 'codex', sessionRef: 's', sessionTitle: '스킬을 개선해 보자', workspace: '/w/kit' });
    store.upsertSearchDoc(id, { name: 'SKILL.md', path: '/w/kit/skills/review/SKILL.md', body: 'x', bodyState: 'indexed', title: 'review — 리뷰' });

    const [row] = search(store, '');
    expect([row.subtitle, row.subtitle_source]).toEqual(['review — 리뷰', 'doc']);
  });
});

group('재색인 — 추출 규칙이 바뀌면 기존 행을 다시 뽑는다', () => {
  test('버전이 바뀌면 search_docs 가 pending 으로 돌아간다', () => {
    const id = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    store.upsertSearchDoc(id, { name: 'a.md', path: '/x/a.md', body: 'b', bodyState: 'indexed' });
    store.setState('extract.rules_version', EXTRACT_RULES_VERSION - 1);
    store.close();

    store = new CatalogStore(join(dir, 'c.db'));
    expect(store.db.query('SELECT body_state FROM search_docs WHERE artifact_id = ?').get(id).body_state).toBe('pending');
    expect(store.getState('extract.rules_version')).toBe(String(EXTRACT_RULES_VERSION));
  });

  test('title 컬럼이 없던 카탈로그를 열면 붙는다', () => {
    store.close();
    const path = join(dir, 'old.db');
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE search_docs (artifact_id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      body TEXT, meta TEXT, body_state TEXT NOT NULL DEFAULT 'pending', updated_at INTEGER NOT NULL)`);
    old.close();

    store = new CatalogStore(path);
    const columns = store.db.query('PRAGMA table_info(search_docs)').all().map((c) => c.name);
    expect(columns).toContain('title');
  });

  test('Aside 리더가 없어도 워처가 pending 을 다시 뽑는다', async () => {
    const path = join(dir, 'doc.md');
    writeFileSync(path, '# 워처가 뽑은 제목\n본문');
    const id = store.insertArtifact({ pathKey: path, absPath: path, fileName: 'doc.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    store.upsertSearchDoc(id, { name: 'doc.md', path, body: null, bodyState: 'pending' });

    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false });
    await watcher.collect();

    expect(store.db.query('SELECT title, body_state FROM search_docs WHERE artifact_id = ?').get(id))
      .toEqual({ title: '워처가 뽑은 제목', body_state: 'indexed' });
  });

  test('번들을 다시 뽑아도 구성 파일 목록이 남는다', async () => {
    const bundle = join(dir, 'gen-app');
    const id = store.insertArtifact({ pathKey: bundle, absPath: bundle, fileName: 'gen-app', ext: '', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    store.setBundleFiles(id, 2);
    store.upsertSearchDoc(id, { name: 'gen-app', path: bundle, body: 'package.json\nsrc/index.mjs', bodyState: 'pending' });

    await indexPending(store);

    expect(store.db.query('SELECT body, body_state FROM search_docs WHERE artifact_id = ?').get(id))
      .toEqual({ body: 'package.json\nsrc/index.mjs', body_state: 'indexed' });
  });
});

group('기간 — 에이전트가 손댄 시각으로 자른다', () => {
  // bun test 는 TZ 를 UTC 로 돌린다. 날짜 계산은 전부 JS 의 지역 시각 한 곳에서 한다.
  const now = new Date(2026, 8, 18, 15);
  const at = (y, m, d, hour = 9) => Math.floor(new Date(y, m, d, hour).getTime() / 1000);

  function made(name, ext, origins, { state = 'discovered', mtime = 1 } = {}) {
    const path = `/w/r/${name}`;
    const id = store.insertArtifact({ pathKey: path, absPath: path, fileName: name, ext, sizeBytes: 1, contentHash: path, fileId: null, mtime });
    if (state === 'final') store.db.query("UPDATE artifacts SET state = 'final' WHERE id = ?").run(id);
    for (const origin of origins) store.recordOrigin(id, origin);
    return id;
  }
  const codex = (sessionRef, createdAt, extra = {}) => ({ collector: 'codex', sessionRef, provider: 'openai-codex', createdAt, ...extra });

  test('7일은 엿새 전 자정부터다 — 오늘을 포함해 이레', async () => {
    const { periodStart } = await import('../lib/search.mjs');
    expect(periodStart('7d', now)).toBe(at(2026, 8, 12, 0));
    expect(periodStart('today', now)).toBe(at(2026, 8, 18, 0));
    expect(periodStart('all', now)).toBeNull();
    expect(periodStart('bogus', now)).toBeNull();
  });

  test('파일 mtime 이 아니라 에이전트가 손댄 시각으로 거른다', async () => {
    const { periodStart, search } = await import('../lib/search.mjs');
    made('touched-recently.md', 'md', [codex('s1', at(2026, 8, 16))], { mtime: at(2026, 5, 1) });
    made('edited-by-hand.md', 'md', [codex('s2', at(2026, 5, 1))], { mtime: at(2026, 8, 17) });

    const rows = search(store, '', { view: 'library', since: periodStart('7d', now) });
    expect(rows.map((r) => r.file_name)).toEqual(['touched-recently.md']);
  });

  test('현황 숫자는 누른 뒤의 목록과 같은 조건으로 센다', async () => {
    const { overview, periodStart, searchCount } = await import('../lib/search.mjs');
    made('old.md', 'md', [codex('s1', at(2026, 7, 1))], { state: 'final' });
    made('new.md', 'md', [codex('s2', at(2026, 8, 17))]);
    made('main.rs', 'rs', [codex('s3', at(2026, 8, 17))]);

    const numbers = overview(store, now);
    expect([numbers.library, numbers.final, numbers.recent]).toEqual([2, 1, 1]);
    expect(numbers.recent).toBe(searchCount(store, '', { view: 'library', since: periodStart(numbers.recentPeriod, now) }));
  });

  test('최근 작업은 대화 단위로 센다 — 서브에이전트 스레드가 숫자를 부풀리지 않는다', async () => {
    const { overview } = await import('../lib/search.mjs');
    const recent = Math.floor(now.getTime() / 1000) - 60;
    made('a.md', 'md', [
      ...['root', 'sub-1', 'sub-2'].map((thread) => codex(thread, recent, { conversationRef: 'root' })),
      codex('long-ago', at(2026, 8, 10)),
    ]);
    expect(overview(store, now).activeConversations).toBe(1);
  });

  test('검색 행에 마지막으로 손댄 시각이 실린다 — 날짜 묶기가 기간과 같은 시각을 본다', async () => {
    const { search } = await import('../lib/search.mjs');
    made('a.md', 'md', [codex('s1', at(2026, 8, 10)), codex('s2', at(2026, 8, 16))], { mtime: at(2026, 5, 1) });
    expect(search(store, '')[0].touched_at).toBe(at(2026, 8, 16));
  });

  test('활동 보기도 같은 기간을 따른다', async () => {
    const { activity, periodStart } = await import('../lib/search.mjs');
    made('a.md', 'md', [codex('today', at(2026, 8, 18)), codex('last-month', at(2026, 7, 1))]);
    expect(activity(store, { since: periodStart('today', now) }).map((s) => s.session_ref)).toEqual(['today']);
  });
});

group('활동 그래프 — 칸마다 에이전트별로 센다', () => {
  const now = new Date(2026, 8, 18, 15);
  const at = (y, m, d, hour = 9) => Math.floor(new Date(y, m, d, hour).getTime() / 1000);
  function made(name, ext, origins) {
    const path = `/w/r/${name}`;
    const id = store.insertArtifact({ pathKey: path, absPath: path, fileName: name, ext, sizeBytes: 1, contentHash: path, fileId: null, mtime: 1 });
    for (const origin of origins) store.recordOrigin(id, origin);
    return id;
  }

  test('며칠이면 하루 한 칸, 지역 자정으로 자르고 빈 날도 채운다', async () => {
    const { timeline } = await import('../lib/search.mjs');
    made('a.md', 'md', [{ collector: 'codex', sessionRef: 's1', provider: 'openai-codex', createdAt: at(2026, 8, 18, 0) + 60 }]);
    made('b.md', 'md', [{ collector: 'codex', sessionRef: 's2', provider: 'openai-codex', createdAt: at(2026, 8, 17, 23) }]);
    made('c.md', 'md', [{ collector: 'claude-code', sessionRef: 's3', provider: 'claude-code', createdAt: at(2026, 8, 18) }]);

    const result = timeline(store, '', { view: 'library' }, '7d', now);
    expect(result.unit).toBe('day');
    expect(result.buckets.map((b) => b.key)).toEqual(['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
    expect(result.buckets.slice(-3).map((b) => b.counts)).toEqual([{}, { 'openai-codex': 1 }, { 'openai-codex': 1, 'claude-code': 1 }]);
  });

  test('오늘은 시간 한 칸, 지금 시각까지만', async () => {
    const { timeline } = await import('../lib/search.mjs');
    made('a.md', 'md', [{ collector: 'codex', sessionRef: 's1', provider: 'openai-codex', createdAt: at(2026, 8, 18, 9) + 1800 }]);
    const result = timeline(store, '', { view: 'library' }, 'today', now);
    expect(result.unit).toBe('hour');
    expect(result.buckets).toHaveLength(16);
    expect(result.buckets[9]).toMatchObject({ key: '2026-09-18T09', counts: { 'openai-codex': 1 } });
  });

  test('전체는 첫 기록이 든 주의 월요일부터 한 주 한 칸', async () => {
    const { timeline } = await import('../lib/search.mjs');
    made('a.md', 'md', [{ collector: 'codex', sessionRef: 's1', provider: 'openai-codex', createdAt: at(2026, 8, 3) }]);
    const result = timeline(store, '', { view: 'library' }, 'all', now);
    expect(result.unit).toBe('week');
    expect(result.buckets.map((b) => b.key)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
    expect(result.buckets[0].counts).toEqual({ 'openai-codex': 1 });
  });

  test('전체가 두 해를 넘으면 천장에서 자른다', async () => {
    const { timeline } = await import('../lib/search.mjs');
    const { MAX_TIMELINE_WEEKS } = await import('../lib/paths.mjs');
    made('ancient.md', 'md', [{ collector: 'codex', sessionRef: 's1', provider: 'openai-codex', createdAt: at(2020, 0, 1) }]);
    expect(timeline(store, '', { view: 'library' }, 'all', now).buckets).toHaveLength(MAX_TIMELINE_WEEKS);
  });

  test('라이브러리 규칙을 따른다 — 목록에 없는 코드는 세지 않고, 에이전트가 없으면 모름', async () => {
    const { timeline } = await import('../lib/search.mjs');
    made('main.rs', 'rs', [{ collector: 'codex', sessionRef: 's1', provider: 'openai-codex', createdAt: at(2026, 8, 18) }]);
    made('x.md', 'md', [{ collector: 'aside', sessionRef: 's3', provider: '', createdAt: at(2026, 8, 18) }]);
    const result = timeline(store, '', { view: 'library' }, '7d', now);
    expect(result.providers).toEqual(['unknown']);
    expect(result.buckets.at(-1).counts).toEqual({ unknown: 1 });
  });

  test('한 파일을 같은 칸에서 여러 스레드가 건드려도 한 번이다', async () => {
    const { timeline } = await import('../lib/search.mjs');
    made('a.md', 'md', ['t1', 't2', 't3'].map((thread) =>
      ({ collector: 'codex', sessionRef: thread, conversationRef: 't1', provider: 'openai-codex', createdAt: at(2026, 8, 18) })));
    expect(timeline(store, '', { view: 'library' }, '7d', now).buckets.at(-1).counts).toEqual({ 'openai-codex': 1 });
  });

  test('에이전트를 고르면 그 에이전트의 기록만 센다 — 같은 파일을 만진 다른 에이전트는 빠진다', async () => {
    const { timeline } = await import('../lib/search.mjs');
    made('both.md', 'md', [
      { collector: 'codex', sessionRef: 's1', provider: 'openai-codex', createdAt: at(2026, 8, 18, 9) },
      { collector: 'claude-code', sessionRef: 's2', provider: 'claude-code', createdAt: at(2026, 8, 18, 10) },
    ]);
    const result = timeline(store, '', { view: 'library', provider: 'claude-code' }, '7d', now);
    expect(result.buckets.at(-1).counts).toEqual({ 'claude-code': 1 });
  });
});
