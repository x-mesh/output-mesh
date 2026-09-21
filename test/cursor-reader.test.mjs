import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURSOR_STATE_DB, CursorReader } from '../lib/cursor-reader.mjs';

let dir;
let dbPath;

/** Cursor 의 state.vscdb 를 흉내 낸다. 실제 형식은 키-값 한 테이블이고 값은 JSON 문자열이다. */
function writeComposers(rows) {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.query('INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES(?, ?)');
  for (const [key, value] of rows) insert.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a-out-cursor-'));
  dbPath = join(dir, 'state.vscdb');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const reader = () => new CursorReader(dbPath);

describe('Cursor composer 읽기', () => {
  test('고친 파일과 새로 만든 파일을 함께 모으고 file:// 를 벗긴다', () => {
    writeComposers([['composerData:c1', {
      composerId: 'c1',
      name: '피어 설정 정리',
      createdAt: 1_700_000_000_000,
      lastUpdatedAt: 1_700_000_600_000,
      newlyCreatedFiles: ['file:///w/repo/src/new.swift'],
      originalFileStates: [{ uri: { fsPath: '/w/repo/src/old.swift' } }],
    }]]);

    const [got] = reader().composers();
    expect(got).toMatchObject({ sessionRef: 'c1', title: '피어 설정 정리', occurredAt: 1_700_000_000 });
    expect(got.paths.sort()).toEqual(['/w/repo/src/new.swift', '/w/repo/src/old.swift']);
  });

  test('파일을 건드리지 않은 대화는 빼고 준다 — 실측 48건 중 10건만 파일이 있다', () => {
    writeComposers([
      ['composerData:empty', { composerId: 'empty', lastUpdatedAt: 5, newlyCreatedFiles: [], originalFileStates: [] }],
      ['composerData:used', { composerId: 'used', lastUpdatedAt: 6, newlyCreatedFiles: ['file:///w/a.md'] }],
    ]);
    expect(reader().composers().map((c) => c.sessionRef)).toEqual(['used']);
  });

  test('composerData 가 아닌 키는 읽지 않는다 — agentKv 는 세션도 시각도 없어 버린다', () => {
    writeComposers([
      ['agentKv:blob:abc', { toolName: 'Write', path: '/w/should-not-appear.md' }],
      ['bubbleId:x', { path: '/w/also-not.md' }],
      ['composerData:c1', { composerId: 'c1', lastUpdatedAt: 9, newlyCreatedFiles: ['file:///w/yes.md'] }],
    ]);
    const all = reader().composers().flatMap((c) => c.paths);
    expect(all).toEqual(['/w/yes.md']);
  });

  test('커서는 밀리초 그대로 쓴다 — 초로 줄이면 같은 밀리초의 대화가 가려진다', () => {
    writeComposers([
      ['composerData:old', { composerId: 'old', lastUpdatedAt: 1_700_000_000_400, newlyCreatedFiles: ['file:///w/a.md'] }],
      ['composerData:new', { composerId: 'new', lastUpdatedAt: 1_700_000_000_900, newlyCreatedFiles: ['file:///w/b.md'] }],
    ]);
    expect(reader().composers(1_700_000_000_400).map((c) => c.sessionRef)).toEqual(['new']);
    expect(reader().composers().map((c) => c.sessionRef)).toEqual(['old', 'new']);
  });

  test('깨진 JSON 한 행이 나머지를 자르지 않는다', () => {
    writeComposers([
      ['composerData:broken', '{{{'],
      ['composerData:ok', { composerId: 'ok', lastUpdatedAt: 3, newlyCreatedFiles: ['file:///w/a.md'] }],
    ]);
    expect(reader().composers().map((c) => c.sessionRef)).toEqual(['ok']);
  });

  test('퍼센트 인코딩된 URI 를 푼다. 경로가 아닌 값은 버린다', () => {
    writeComposers([['composerData:c1', {
      composerId: 'c1',
      lastUpdatedAt: 4,
      newlyCreatedFiles: ['file:///w/repo/%EB%AC%B8%EC%84%9C.md', 'untitled:Untitled-1', 'file:///w/repo/ok.md'],
    }]]);
    expect(reader().composers()[0].paths.sort()).toEqual(['/w/repo/document.md'.replace('document', '문서'), '/w/repo/ok.md'].sort());
  });

  test('Cursor 가 없는 머신에서는 조용히 빈 목록이다', () => {
    expect(new CursorReader(join(dir, 'nope.vscdb')).available()).toBe(false);
    expect(new CursorReader(join(dir, 'nope.vscdb')).composers()).toEqual([]);
  });
});

describe('Cursor 라이브 계약', () => {
  const live = existsSync(CURSOR_STATE_DB);
  test.skipIf(!live)('실제 state.vscdb 를 읽기 전용으로 열고 쓰기를 거부한다', () => {
    const db = new CursorReader().open();
    try {
      expect(() => db.exec('CREATE TABLE a_out_probe(x)')).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });

  test.skipIf(!live)('파일을 건드린 대화가 절대 경로와 시각을 준다', () => {
    for (const composer of new CursorReader().composers()) {
      expect(composer.sessionRef).toBeTruthy();
      expect(composer.occurredAt).toBeGreaterThan(0);
      for (const path of composer.paths) expect(path.startsWith('/')).toBe(true);
    }
  });
});
