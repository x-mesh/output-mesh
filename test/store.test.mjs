import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { KIND_RULES_VERSION } from '../lib/extract.mjs';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a-out-store-'));
  store = new CatalogStore(join(dir, 'catalog.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(overrides = {}) {
  return store.insertArtifact({
    pathKey: '/s/artifacts/a.md',
    absPath: '/s/artifacts/a.md',
    fileName: 'a.md',
    ext: 'md',
    sizeBytes: 12,
    contentHash: 'aa',
    fileId: '1:2',
    mtime: 100,
    ...overrides,
  });
}

describe('부트스트랩', () => {
  test('WAL 모드로 연다', () => {
    expect(store.journalMode()).toBe('wal');
  });
  test('foreign_keys 가 켜져 있다 — 꺼져 있으면 CASCADE 가 죽은 코드가 된다', () => {
    expect(store.db.query('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });
  test('스키마 적용은 멱등이다', () => {
    const again = new CatalogStore(join(dir, 'catalog.db'));
    expect(again.counts().artifacts).toBe(0);
    again.close();
  });
});

describe('아티팩트 왕복', () => {
  test('삽입 후 path_key 로 찾는다', () => {
    const id = seed();
    const row = store.byPathKey('/s/artifacts/a.md');
    expect(row.id).toBe(id);
    expect(row.content_hash).toBe('aa');
  });
  test('출처와 태그가 붙는다', () => {
    const id = seed();
    store.recordOrigin(id, { collector: 'aside', provider: 'claude-code', sessionRef: 'S1', isDeliverable: true });
    store.addTag(id, '보고서');
    expect(store.tagsOf(id)).toEqual(['보고서']);
    expect(store.counts()).toMatchObject({ artifacts: 1, enriched: 1, deliverable: 1 });
  });
  test('같은 태그를 두 번 붙여도 한 번만 붙는다', () => {
    const id = seed();
    store.addTag(id, '보고서');
    store.addTag(id, '보고서');
    expect(store.tagsOf(id)).toEqual(['보고서']);
  });
  test('NFD 로 들어온 태그가 두 번째 태그가 되지 않는다', () => {
    const id = seed();
    store.addTag(id, '보고서'.normalize('NFC'));
    store.addTag(id, '보고서'.normalize('NFD'));
    expect(store.tagsOf(id)).toHaveLength(1);
  });
});

describe('사용자 소유 상태', () => {
  test('사용자가 정한 상태를 자동 스윕이 덮어쓰지 못한다', () => {
    const id = seed();
    store.setUserState(id, 'discovered');
    store.applyAutoState(id, 'final');
    expect(store.byPathKey('/s/artifacts/a.md').state).toBe('discovered');
  });
  test('final 로 표시하면 그 시점 해시를 남겨 이후 변경을 알 수 있다', () => {
    const id = seed();
    store.setUserState(id, 'final');
    expect(store.byPathKey('/s/artifacts/a.md').final_hash).toBe('aa');
    store.updateContent(id, { contentHash: 'bb', sizeBytes: 13, mtime: 200, fileId: '1:2' });
    const row = store.byPathKey('/s/artifacts/a.md');
    expect(row.state).toBe('final');
    expect(row.final_hash).not.toBe(row.content_hash);
  });
  test('원본이 사라져도 행과 태그가 살아남는다', () => {
    const id = seed();
    store.addTag(id, '보관');
    store.markMissing([id], 999);
    const row = store.byPathKey('/s/artifacts/a.md');
    expect(row.missing_at).toBe(999);
    expect(store.tagsOf(id)).toEqual(['보관']);
  });
});

describe('중복 그룹', () => {
  test('해시가 같은 두 경로를 묶는다', () => {
    seed();
    seed({ pathKey: '/d/a.md', absPath: '/d/a.md' });
    expect(store.duplicateGroups()).toEqual([{ content_hash: 'aa', n: 2 }]);
  });
  test('해시가 없는 행은 서로의 중복이 아니다 — GROUP BY 가 NULL 을 한 그룹으로 묶는 함정', () => {
    seed({ pathKey: '/x/1.bin', absPath: '/x/1.bin', contentHash: null });
    seed({ pathKey: '/x/2.bin', absPath: '/x/2.bin', contentHash: null });
    expect(store.duplicateGroups()).toEqual([]);
  });
  test('사라진 원본은 중복 그룹에서 빠진다', () => {
    const a = seed();
    seed({ pathKey: '/d/a.md', absPath: '/d/a.md' });
    store.markMissing([a]);
    expect(store.duplicateGroups()).toEqual([]);
  });
});

describe('FTS 색인', () => {
  test('search_docs 쓰기가 FTS 로 전파되고 무결성 검사를 통과한다', () => {
    const id = seed();
    store.upsertSearchDoc(id, { name: 'a.md', path: '/s/artifacts/a.md', body: '분기별 매출흐름', meta: '보고서', bodyState: 'indexed' });
    expect(store.db.query('SELECT count(*) n FROM artifact_fts WHERE artifact_fts MATCH ?').get('매출흐름').n).toBe(1);
    expect(store.ftsIntegrityOk()).toBe(true);
  });
  test('갱신하면 옛 본문이 색인에 남지 않는다', () => {
    const id = seed();
    store.upsertSearchDoc(id, { name: 'a.md', path: '/p', body: '옛날내용', meta: '', bodyState: 'indexed' });
    store.upsertSearchDoc(id, { name: 'a.md', path: '/p', body: '새로운내용', meta: '', bodyState: 'indexed' });
    const hits = (q) => store.db.query('SELECT count(*) n FROM artifact_fts WHERE artifact_fts MATCH ?').get(q).n;
    expect(hits('옛날내용')).toBe(0);
    expect(hits('새로운내용')).toBe(1);
  });
  test('아티팩트를 지우면 FTS 행도 따라 사라진다', () => {
    const id = seed();
    store.upsertSearchDoc(id, { name: 'a.md', path: '/p', body: '지워질내용', meta: '', bodyState: 'indexed' });
    store.db.query('DELETE FROM artifacts WHERE id = ?').run(id);
    expect(store.db.query('SELECT count(*) n FROM artifact_fts WHERE artifact_fts MATCH ?').get('지워질내용').n).toBe(0);
    expect(store.ftsIntegrityOk()).toBe(true);
  });
});

describe('수집 커서', () => {
  test('없으면 null, 쓰면 문자열로 돌아온다', () => {
    expect(store.getState('aside.turn_cursor')).toBeNull();
    store.setState('aside.turn_cursor', 259);
    expect(store.getState('aside.turn_cursor')).toBe('259');
  });
});

describe('스키마 성장', () => {
  test('kind 컬럼이 없던 카탈로그를 열면 사용자 데이터를 잃지 않고 채운다', () => {
    const id = seed({ pathKey: '/s/artifacts/보고서.md', absPath: '/s/artifacts/보고서.md', fileName: '보고서.md' });
    store.addTag(id, '중요');
    store.setNote(id, '지우면 안 됨');
    store.setUserState(id, 'final');
    const path = store.db.filename;

    // 컬럼이 없던 시절의 모양을 되돌린다. 픽스처 DB 를 커밋하는 것보다 이게 정직하다.
    store.db.query('ALTER TABLE artifacts DROP COLUMN kind').run();
    expect(store.db.query('PRAGMA table_info(artifacts)').all().map((c) => c.name)).not.toContain('kind');
    store.close();

    store = new CatalogStore(path);
    const row = store.byPathKey('/s/artifacts/보고서.md');
    expect(row.kind).toBe('text');
    expect(row.state).toBe('final');
    expect(row.note).toBe('지우면 안 됨');
    expect(store.tagsOf(id)).toEqual(['중요']);
    expect(store.counts().kindNull).toBe(0);
  });

  test('분류 규칙이 바뀌면 기존 행을 다시 매긴다 — 캐시에는 무효화 키가 필요하다', () => {
    const id = seed();
    const path = store.db.filename;
    store.db.query("UPDATE artifacts SET kind = 'elvish'").run();
    store.setState('kind.rules_version', '0');
    store.close();

    store = new CatalogStore(path);
    expect(store.byPathKey('/s/artifacts/a.md').kind).toBe('text');
    expect(store.getState('kind.rules_version')).toBe(String(KIND_RULES_VERSION));
    expect(id).toBeGreaterThan(0);
  });

  test('doctor 가 분류 빈 행을 보이게 한다 — 최악의 실패를 관측 가능하게', () => {
    seed();
    expect(store.counts().kindNull).toBe(0);
    store.db.query('UPDATE artifacts SET kind = NULL').run();
    expect(store.counts().kindNull).toBe(1);
  });
});

describe('분류를 store 가 파생한다', () => {
  test('삽입 시 파일명까지 보고 매긴다', () => {
    const cases = [['a.md', 'text'], ['App.swift', 'code'], ['.zshrc', 'code'], ['Makefile', 'code'], ['shot.png', 'image']];
    for (const [name, kind] of cases) {
      const id = seed({ pathKey: `/s/${name}`, absPath: `/s/${name}`, fileName: name, ext: name.includes('.') && !name.startsWith('.') ? name.split('.').pop() : '' });
      expect([name, store.db.query('SELECT kind FROM artifacts WHERE id = ?').get(id).kind]).toEqual([name, kind]);
    }
  });

  test('번들 표시와 분류가 한 문장에서 쓰여 어긋날 수 없다', () => {
    const id = seed();
    store.setBundleFiles(id, 12);
    const row = store.byPathKey('/s/artifacts/a.md');
    expect([row.bundle_files, row.kind]).toEqual([12, 'bundle']);
  });

  test('이름이 바뀌면 확장자와 분류가 따라간다', () => {
    const id = seed();
    store.relocate(id, { pathKey: '/s/artifacts/a.swift', absPath: '/s/artifacts/a.swift', fileName: 'a.swift', mtime: 2, sizeBytes: 9 });
    const row = store.byPathKey('/s/artifacts/a.swift');
    expect([row.ext, row.kind]).toEqual(['swift', 'code']);
  });
});

describe('빈 페이지를 재보고 회수한다', () => {
  const rows = (n) => {
    for (let i = 0; i < n; i++) {
      const id = seed({ pathKey: `/s/artifacts/${i}.md`, absPath: `/s/artifacts/${i}.md`, fileName: `${i}.md`, contentHash: String(i) });
      store.upsertSearchDoc(id, { name: `${i}.md`, path: `/s/artifacts/${i}.md`, body: 'x'.repeat(4000), meta: null, bodyState: 'indexed', title: `t${i}` });
    }
  };

  test('파일 크기와 빈 자리를 같은 단위로 준다', () => {
    rows(20);
    const { bytes, freeBytes, freeRatio } = store.storage();
    expect(bytes).toBeGreaterThan(0);
    expect(freeBytes).toBeLessThanOrEqual(bytes);
    expect(freeRatio).toBeCloseTo(freeBytes / bytes, 10);
  });

  test('지운 자리는 회수 전까지 파일에 남는다', () => {
    rows(200);
    const full = store.storage().bytes;
    store.db.query('DELETE FROM artifacts').run();
    const emptied = store.storage();
    // 행을 지워도 파일은 그대로다. auto_vacuum 이 꺼져 있어 빈 페이지로만 표시된다.
    expect(emptied.bytes).toBe(full);
    expect(emptied.freeRatio).toBeGreaterThan(0.3);

    const { before, after } = store.compact();
    expect(before).toBe(full);
    expect(after).toBeLessThan(before);
    expect(store.storage().freeRatio).toBe(0);
  });

  test('회수해도 남은 행과 사용자 데이터는 그대로다 — VACUUM 이 rowid 를 다시 매긴다', () => {
    rows(50);
    const keep = store.byPathKey('/s/artifacts/7.md').id;
    store.setState('cursor.scanned_until', '1234');
    store.db.query('DELETE FROM artifacts WHERE path_key <> ?').run('/s/artifacts/7.md');

    store.compact();
    expect(store.counts().artifacts).toBe(1);
    expect(store.byPathKey('/s/artifacts/7.md').id).toBe(keep);
    expect(store.getState('cursor.scanned_until')).toBe('1234');
  });
});
