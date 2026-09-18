import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore, repairCollector } from '../lib/store.mjs';
import { ingestFile, reindexArtifact } from '../lib/collector.mjs';
import { activity, facets, search, searchCount } from '../lib/search.mjs';
import { nfc } from '../lib/paths.mjs';

let dir;
let store;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a-out-origins-'));
  mkdirSync(join(dir, 'repo'), { recursive: true });
  file = join(dir, 'repo', 'README.md');
  writeFileSync(file, '# 문서');
  store = new CatalogStore(join(dir, 'c.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const codex = (sessionRef, extra = {}) => ({ collector: 'codex', provider: 'openai-codex', sessionRef, ...extra });
const claude = (sessionRef, extra = {}) => ({ collector: 'claude-code', provider: 'claude-code', sessionRef, ...extra });
const idOf = () => store.byPathKey(nfc(file)).id;

describe('출처는 세션마다 한 줄이다', () => {
  test('두 수집기가 같은 파일을 건드리면 두 줄이 되고 서로를 오염시키지 않는다 — 원래 버그', async () => {
    // 실측: 37행이 collector=codex 인데 session_ref 는 Claude UUID, provider 는 claude-code 였다.
    await ingestFile(store, file, codex('cx-1', { sessionTitle: 'Codex 작업' }));
    await ingestFile(store, file, claude('cc-1', { sessionTitle: 'Claude 작업' }));

    const rows = store.originsOf(idOf());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.collector, r.provider, r.session_ref, r.session_title]).sort()).toEqual([
      ['claude-code', 'claude-code', 'cc-1', 'Claude 작업'],
      ['codex', 'openai-codex', 'cx-1', 'Codex 작업'],
    ]);
    expect(store.counts().chimeraOrigins).toBe(0);
  });

  test('내용이 그대로인 touched 경로가 두 번째 세션을 삽입한다 — 148개가 사라지던 경로', async () => {
    await ingestFile(store, file, codex('cx-1'));
    const second = await ingestFile(store, file, codex('cx-2'));
    expect(second.rule).toBe('touched');
    expect(store.originsOf(idOf()).map((r) => r.session_ref).sort()).toEqual(['cx-1', 'cx-2']);
  });

  test('같은 세션이 두 번 건드려도 한 줄이고 first_seen_at 은 불변이다', () => {
    const id = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    store.recordOrigin(id, codex('cx-1'), 100);
    store.recordOrigin(id, codex('cx-1', { sessionTitle: '나중에 알게 된 제목' }), 200);

    const [row] = store.originsOf(id);
    expect(store.originsOf(id)).toHaveLength(1);
    expect([row.first_seen_at, row.last_seen_at, row.session_title]).toEqual([100, 200, '나중에 알게 된 제목']);
  });

  test('세션 개념이 없는 가져오기는 반복해도 한 줄이다 — NULL 키는 매번 새 행이 된다', () => {
    const id = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    store.recordOrigin(id, { collector: 'import' });
    store.recordOrigin(id, { collector: 'import' });
    expect(store.originsOf(id)).toHaveLength(1);
  });

  test('산출물 표시는 다른 출처가 늘어도 취소되지 않는다', () => {
    const id = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    store.recordOrigin(id, { collector: 'aside', sessionRef: 'as-1', isDeliverable: true });
    store.recordOrigin(id, { collector: 'aside', sessionRef: 'as-1', isDeliverable: false });
    store.recordOrigin(id, codex('cx-1'));
    expect(store.counts().deliverable).toBe(1);
  });
});

describe('대표 출처', () => {
  test('occurred_at 이 같아도 VACUUM 전후로 같은 대표가 나온다 — rowid tiebreak 는 뒤집힌다', () => {
    const id = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    store.recordOrigin(id, codex('zz', { createdAt: 500 }));
    store.recordOrigin(id, claude('aa', { createdAt: 500 }));

    const before = store.originsOf(id)[0];
    store.db.exec('VACUUM');
    const after = store.originsOf(id)[0];
    expect([after.collector, after.session_ref]).toEqual([before.collector, before.session_ref]);
    expect(before.collector).toBe('claude-code');
  });

  test('공급자 칩은 정렬돼 호출마다 같다 — group_concat 은 순서를 보장하지 않는다', async () => {
    await ingestFile(store, file, codex('cx-1'));
    await ingestFile(store, file, claude('cc-1'));
    await reindexArtifact(store, idOf());
    const first = search(store, '')[0].providers;
    const second = search(store, '')[0].providers;
    expect(first).toEqual(['claude-code', 'openai-codex']);
    expect(second).toEqual(first);
  });

  test('산출물 표시가 있는 출처가 대표가 된다', () => {
    const id = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    store.recordOrigin(id, codex('cx-1', { createdAt: 900 }));
    store.recordOrigin(id, { collector: 'aside', sessionRef: 'as-1', isDeliverable: true, createdAt: 100 });
    expect(store.originsOf(id)[0].collector).toBe('aside');
  });
});

describe('필터와 건수', () => {
  beforeEach(async () => {
    await ingestFile(store, file, codex('cx-1', { workspace: '/w/repo' }));
    await ingestFile(store, file, claude('cc-1', { workspace: '/w/repo' }));
    await reindexArtifact(store, idOf());
  });

  test('공급자 필터는 어느 출처 하나만 맞아도 걸린다', () => {
    expect(search(store, '', { provider: 'openai-codex' })).toHaveLength(1);
    expect(search(store, '', { provider: 'claude-code' })).toHaveLength(1);
  });

  test('출처가 여럿이어도 건수가 부풀지 않는다 — 출처를 조인하면 출처 수만큼 세어진다', () => {
    expect(store.originsOf(idOf())).toHaveLength(2);
    expect(searchCount(store, '')).toBe(1);
    expect(search(store, '')).toHaveLength(1);
  });

  test('공급자 패싯 합이 목록 총계를 넘지 않는다 — 한 아티팩트는 공급자마다 한 번', () => {
    const f = facets(store, {});
    expect(f.providers).toEqual(expect.arrayContaining([
      { value: 'claude-code', n: 1 },
      { value: 'openai-codex', n: 1 },
    ]));
    expect(f.workspaces).toEqual([{ value: '/w/repo', n: 1 }]);
  });

  test('여러 세션의 기억 어느 쪽으로도 찾아진다', async () => {
    store.recordOrigin(idOf(), codex('cx-1', { sessionTitle: '릴레이 성능 조사' }));
    store.recordOrigin(idOf(), claude('cc-1', { sessionTitle: '문서 번역 정리' }));
    await reindexArtifact(store, idOf());
    expect(search(store, '릴레이 성능')).toHaveLength(1);
    expect(search(store, '문서 번역')).toHaveLength(1);
  });
});

describe('활동', () => {
  test('한 세션의 파일 수는 턴 수가 아니라 파일 수다', () => {
    const id = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
    for (const turn of ['t1', 't2', 't3', 't4']) {
      store.recordOrigin(id, { collector: 'aside', sessionRef: 'as-1', turnRef: turn });
    }
    const [session] = activity(store);
    expect(session.file_count).toBe(1);
    expect(session.files).toHaveLength(1);
  });

  test('두 수집기의 세션이 각각 활동 카드가 된다', async () => {
    await ingestFile(store, file, codex('cx-1'));
    await ingestFile(store, file, claude('cc-1'));
    expect(activity(store).map((s) => s.collector).sort()).toEqual(['claude-code', 'codex']);
  });
});

describe('1:1 에서 옮겨 오기', () => {
  /** 출처 테이블이 생기기 전의 카탈로그를 흉내낸다. */
  function legacyCatalog(rows) {
    const path = store.db.filename;
    for (const row of rows) {
      const id = store.insertArtifact({ pathKey: row.path, absPath: row.path, fileName: row.path.split('/').pop(), ext: 'md', sizeBytes: 1, contentHash: row.path, fileId: null, mtime: 1 });
      store.db
        .query(`INSERT INTO provenance (artifact_id, collector, provider, session_ref, session_title, session_dir, created_at, is_deliverable)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, row.collector, row.provider ?? null, row.sessionRef ?? null, row.title ?? null, row.sessionDir ?? null, 100, row.deliverable ? 1 : 0);
      row.id = id;
    }
    store.db.exec('DELETE FROM artifact_origins');
    return path;
  }

  test('마이그레이션 후 출처 없는 아티팩트가 0 이다 — 칩과 활동에서 조용히 사라지지 않는다', () => {
    const path = legacyCatalog([{ path: '/x/a.md', collector: 'codex', provider: 'openai-codex', sessionRef: 'cx-1' }]);
    expect(store.counts().artifactsWithoutOrigin).toBe(1);
    store.close();

    store = new CatalogStore(path);
    expect(store.counts()).toMatchObject({ artifactsWithoutOrigin: 0, originsOrphan: 0, origins: 1 });
  });

  test('태그·메모·final 을 잃지 않는다', () => {
    const rows = [{ path: '/x/보고서.md', collector: 'aside', provider: 'claude-code', sessionRef: 'as-1', deliverable: true }];
    const path = legacyCatalog(rows);
    const id = rows[0].id;
    store.addTag(id, '중요');
    store.setNote(id, '지우면 안 됨');
    store.setFavorite(id, true);
    store.setUserState(id, 'final');
    store.close();

    store = new CatalogStore(path);
    const row = store.byPathKey('/x/보고서.md');
    expect([row.state, row.state_locked, row.note, row.favorite]).toEqual(['final', 1, '지우면 안 됨', 1]);
    expect(store.tagsOf(id)).toEqual(['중요']);
  });

  test('수집기만 낡은 행을 공급자로 되짚어 고친다 — 섞인 37행', () => {
    const path = legacyCatalog([{ path: '/x/a.md', collector: 'codex', provider: 'claude-code', sessionRef: 'f870162c-uuid', title: '❯ /xm:mutate' }]);
    store.close();

    store = new CatalogStore(path);
    const [origin] = store.originsOf(store.byPathKey('/x/a.md').id);
    expect([origin.collector, origin.provider, origin.session_ref]).toEqual(['claude-code', 'claude-code', 'f870162c-uuid']);
    expect(store.counts().chimeraOrigins).toBe(0);
  });

  test('세션 id 가 비어 있던 Aside 행은 디렉터리명에서 채운다 — 스윕 출처와 같은 행에 모인다', () => {
    const path = legacyCatalog([{ path: '/x/b.md', collector: 'aside', sessionDir: '/s/2026-09-11_LQIXe9g5mhi6tWDo' }]);
    store.close();

    store = new CatalogStore(path);
    expect(store.originsOf(store.byPathKey('/x/b.md').id)[0].session_ref).toBe('LQIXe9g5mhi6tWDo');
  });

  test('옮긴 뒤에는 세션 로그를 다시 읽는다 — 버려졌던 출처는 로그에서만 돌아온다', () => {
    store.setState('codex.scanned_until', 999);
    const path = legacyCatalog([{ path: '/x/a.md', collector: 'codex', provider: 'openai-codex', sessionRef: 'cx-1' }]);
    store.close();

    store = new CatalogStore(path);
    expect(store.getState('codex.scanned_until')).toBe('0');
  });

  test('두 번째로 열 때는 아무것도 하지 않는다', () => {
    const path = legacyCatalog([{ path: '/x/a.md', collector: 'codex', provider: 'openai-codex', sessionRef: 'cx-1' }]);
    store.close();
    store = new CatalogStore(path);
    store.setState('codex.scanned_until', 777);
    store.close();

    store = new CatalogStore(path);
    expect(store.getState('codex.scanned_until')).toBe('777');
  });
});

describe('repairCollector', () => {
  test.each([
    ['codex', 'claude-code', 'claude-code'],
    ['codex', 'openai-codex', 'codex'],
    ['claude-code', 'openai-codex', 'codex'],
    ['aside', 'claude-code', 'aside'],
    ['import', null, 'import'],
  ])('%s + %s -> %s', (collector, provider, want) => expect(repairCollector(collector, provider)).toBe(want));
});

describe('활동 시각', () => {
  test('옛 세션은 다른 세션이 같은 파일을 고쳐도 최근으로 올라오지 않는다', () => {
    const id = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 9_000 });
    store.recordOrigin(id, codex('old', { createdAt: 1_000, sessionTitle: '7주 전 작업' }));
    store.recordOrigin(id, claude('new', { createdAt: 9_000, sessionTitle: '오늘 작업' }));

    const sessions = activity(store);
    expect(sessions.map((s) => s.session_title)).toEqual(['오늘 작업', '7주 전 작업']);
    expect(sessions.find((s) => s.session_ref === 'old').at).toBe(1_000);
  });
});

describe('활동은 대화 단위다', () => {
  const thread = (id, conversation, title, createdAt) =>
    codex(id, { conversationRef: conversation, sessionTitle: title, createdAt });

  test('서브에이전트 스레드들이 한 대화의 카드 한 장으로 묶인다 — 롤아웃 42개가 대화 4개였다', () => {
    const a = store.insertArtifact({ pathKey: '/x/a.swift', absPath: '/x/a.swift', fileName: 'a.swift', ext: 'swift', sizeBytes: 1, contentHash: 'a', fileId: null, mtime: 1 });
    const b = store.insertArtifact({ pathKey: '/x/b.swift', absPath: '/x/b.swift', fileName: 'b.swift', ext: 'swift', sizeBytes: 1, contentHash: 'b', fileId: null, mtime: 1 });
    store.recordOrigin(a, thread('root', 'root', 'relay 가 느리다. 확인해봐', 100));
    store.recordOrigin(a, thread('sub-1', 'root', 'You are a leaf code reviewer', 200));
    store.recordOrigin(b, thread('sub-2', 'root', 'Fix the confirmed review findings', 300));

    const cards = activity(store);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ session_ref: 'root', file_count: 2, subagent_count: 2, at: 300 });
  });

  test('카드 제목은 루트 스레드의 과제다 — 서브에이전트의 지시가 대화를 대표하지 않는다', () => {
    const a = store.insertArtifact({ pathKey: '/x/a.swift', absPath: '/x/a.swift', fileName: 'a.swift', ext: 'swift', sizeBytes: 1, contentHash: 'a', fileId: null, mtime: 1 });
    store.recordOrigin(a, thread('sub-1', 'root', 'Zzz 서브에이전트 지시', 900));
    store.recordOrigin(a, thread('root', 'root', 'relay 가 느리다. 확인해봐', 100));
    expect(activity(store)[0].session_title).toBe('relay 가 느리다. 확인해봐');
  });

  test('루트가 파일을 안 썼어도 대화는 제목을 갖는다', () => {
    const a = store.insertArtifact({ pathKey: '/x/a.swift', absPath: '/x/a.swift', fileName: 'a.swift', ext: 'swift', sizeBytes: 1, contentHash: 'a', fileId: null, mtime: 1 });
    store.recordOrigin(a, thread('sub-1', 'root', '서브에이전트 지시', 100));
    expect(activity(store)[0].session_title).toBe('서브에이전트 지시');
  });

  test('여러 스레드가 같은 파일을 건드려도 카드에 파일은 한 번만 보인다', () => {
    const a = store.insertArtifact({ pathKey: '/x/a.swift', absPath: '/x/a.swift', fileName: 'a.swift', ext: 'swift', sizeBytes: 1, contentHash: 'a', fileId: null, mtime: 1 });
    for (const id of ['root', 'sub-1', 'sub-2', 'sub-3']) store.recordOrigin(a, thread(id, 'root', id, 100));
    const [card] = activity(store);
    expect(card.files.map((f) => f.id)).toEqual([a]);
    expect(card.file_count).toBe(1);
  });

  test('대화 정보가 없는 출처는 세션이 곧 대화다 — 컬럼이 채워지기 전에도 틀리지 않는다', () => {
    const a = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'a', fileId: null, mtime: 1 });
    store.recordOrigin(a, { collector: 'aside', sessionRef: 'as-1', sessionTitle: 'Aside 작업' });
    expect(activity(store)[0]).toMatchObject({ session_ref: 'as-1', subagent_count: 0, session_title: 'Aside 작업' });
  });
});

describe('대화 컬럼 마이그레이션', () => {
  test('conversation_ref 가 없던 카탈로그를 열면 컬럼이 붙고 출처는 그대로다', () => {
    const a = store.insertArtifact({ pathKey: '/x/a.md', absPath: '/x/a.md', fileName: 'a.md', ext: 'md', sizeBytes: 1, contentHash: 'a', fileId: null, mtime: 1 });
    store.recordOrigin(a, codex('cx-1'));
    const path = store.db.filename;
    store.db.exec('ALTER TABLE artifact_origins DROP COLUMN conversation_ref');
    store.close();

    store = new CatalogStore(path);
    const columns = store.db.query('PRAGMA table_info(artifact_origins)').all().map((c) => c.name);
    expect(columns).toContain('conversation_ref');
    expect(store.originsOf(a)).toHaveLength(1);
  });
});
