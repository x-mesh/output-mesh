import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AsideReader } from '../lib/aside-reader.mjs';
import { asideAccountDirs } from '../lib/paths.mjs';
import { classifyFilesChangedPath, classifyRelPath } from '../lib/scanner.mjs';

const accounts = asideAccountDirs();
const reader = accounts.length ? new AsideReader(accounts[0]) : null;
const live = reader?.available() ?? false;

// Aside 가 설치되지 않은 머신에서는 통째로 건너뛴다.
const maybe = live ? describe : describe.skip;

const KNOWN_PROVIDERS = new Set(['aside', 'claude-code', 'openai-codex', 'ai-mesh']);

function collectFromDisk() {
  const root = reader.sessionsRoot;
  const out = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (classifyRelPath(relative(root, p)).collect) out.add(relative(root, p));
    }
  };
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) walk(p);
  }
  return out;
}

function collectFromDb() {
  const dirMap = reader.sessionDirMap();
  const out = new Set();
  for (const row of reader.changedFiles(0)) {
    if (row.deliverable_size === null) continue;
    const dir = dirMap.get(row.session_id);
    if (!dir) continue;
    if (classifyFilesChangedPath(dir, row.rel_path).collect) out.add(`${dir}/${row.rel_path}`);
  }
  return out;
}

/** Aside 가 변경으로 기록한 모든 경로. 산출물 표시가 없는 것도 든다. */
function trackedByAside() {
  const dirMap = reader.sessionDirMap();
  const out = new Set();
  for (const row of reader.changedFiles(0)) {
    const dir = dirMap.get(row.session_id);
    if (dir && row.rel_path) out.add(`${dir}/${row.rel_path}`);
  }
  return out;
}

maybe('V1 — Aside 라이브 계약', () => {
  test('원본 DB 는 읽기 전용이다 — 쓰기 시도가 드라이버에서 막힌다', () => {
    const db = reader.open();
    try {
      expect(() => db.exec('CREATE TABLE output_mesh_probe(x)')).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });

  test('WAL 이 적용된다 — 플래그 붙은 항목이 보인다', () => {
    const flagged = reader.changedFiles(0).filter((r) => r.deliverable_size !== null);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
  });

  test('플래그 붙은 경로는 artifacts/ 바로 아래 한 단계다', () => {
    for (const row of reader.changedFiles(0)) {
      if (row.deliverable_size === null) continue;
      expect(row.rel_path.startsWith('artifacts/')).toBe(true);
      expect(row.rel_path.split('/')).toHaveLength(2);
    }
  });

  test('tmp/ 항목은 산출물 플래그를 갖지 않는다', () => {
    const tmpFlagged = reader
      .changedFiles(0)
      .filter((r) => r.rel_path?.startsWith('tmp/') && r.deliverable_size !== null);
    expect(tmpFlagged).toEqual([]);
  });

  test('공급자 목록이 알려진 집합 안에 있다 — 벗어나면 수집기가 이름만 아는 상태로 강등된다', () => {
    const seen = new Set(reader.changedFiles(0).map((r) => r.provider).filter(Boolean));
    const unknown = [...seen].filter((p) => !KNOWN_PROVIDERS.has(p));
    expect({ seen: [...seen], unknown }).toMatchObject({ unknown: [] });
  });

  test('커서는 단조 증가하는 turn rowid 다', () => {
    const max = reader.maxTurnRowid();
    expect(max).toBeGreaterThan(0);
    expect(reader.changedFiles(max)).toEqual([]);
  });

  test('세션 디렉터리명 접미사가 DB 의 sessions.id 와 조인된다', () => {
    const dirMap = reader.sessionDirMap();
    const sessionIds = new Set(reader.changedFiles(0).map((r) => r.session_id));
    const unjoinable = [...sessionIds].filter((id) => !dirMap.has(id));
    expect(unjoinable).toEqual([]);
  });
});

maybe('V3 — 파일시스템 ≡ DB 일치', () => {
  test('Aside 가 기록한 파일에 대해서는 depth-1 규칙과 산출물 플래그가 같은 집합을 고른다', () => {
    const fromDisk = collectFromDisk();
    const fromDb = collectFromDb();
    const tracked = trackedByAside();
    // Aside 가 기록하지 않은 파일은 플래그로 판정할 수 없다. 이미지 생성 도구나 셸이 artifacts/ 에 바로
    // 쓴 것들이고(실측 5개: imagegen-*.png, 스크린샷, .mjs), 디스크 규칙만 그것들을 잡는다.
    const onlyDisk = [...fromDisk].filter((p) => !fromDb.has(p) && tracked.has(p));
    // 표시된 뒤 지워지거나 이름이 바뀐 파일은 어느 규칙의 잘못도 아니다(실측 1개).
    const onlyDb = [...fromDb].filter((p) => !fromDisk.has(p) && existsSync(join(reader.sessionsRoot, p)));
    expect({ onlyDisk, onlyDb }).toEqual({ onlyDisk: [], onlyDb: [] });
    expect(fromDisk.size).toBeGreaterThan(0);
  });
});
