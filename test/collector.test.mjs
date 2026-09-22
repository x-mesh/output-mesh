import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { AsideReader } from '../lib/aside-reader.mjs';
import { collectOnce, enrich, ingestWorkspaceDoc, sweep } from '../lib/collector.mjs';
import { Watcher } from '../lib/watcher.mjs';
import { search } from '../lib/search.mjs';
import { BUNDLE_MIN_FILES, nfc } from '../lib/paths.mjs';

const SESSION_ID = 'TESTSESS000001';
const SESSION_DIR = `2026-01-01_${SESSION_ID}`;

let dir;
let store;
let reader;
let artifactsDir;

function buildStateDb(turns) {
  const db = new Database(join(dir, 'u0', 'state.db'), { create: true });
  db.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, model TEXT);
    CREATE TABLE session_turns(id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT,
                               user_message TEXT, files_changed TEXT, started_at INTEGER, finished_at INTEGER);
  `);
  db.query('INSERT INTO sessions VALUES(?,?,?)').run(SESSION_ID, '테스트 세션', JSON.stringify({ provider: 'claude-code' }));
  const insert = db.query('INSERT INTO session_turns VALUES(?,?,?,?,?,?,?)');
  turns.forEach((turn, i) =>
    insert.run(i + 1, SESSION_ID, `turn-${i + 1}`, JSON.stringify([{ role: 'user', content: turn.prompt ?? '무언가 만들어줘' }]),
      turn.filesChanged, 1000 + i, 1000 + i));
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'output-mesh-collect-'));
  artifactsDir = join(dir, 'u0', 'sessions', SESSION_DIR, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  store = new CatalogStore(join(dir, 'c.db'));
  reader = new AsideReader(join(dir, 'u0'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('V5 — 수집 루프', () => {
  test('(a) 새 산출물이 스윕 한 번에 들어온다', async () => {
    writeFileSync(join(artifactsDir, 'a.md'), '한글 본문입니다');
    const stats = await sweep(store, reader);
    expect(stats).toMatchObject({ scanned: 1, inserted: 1 });
    expect(store.byPathKey(nfc(join(artifactsDir, 'a.md')))).toBeTruthy();
  });

  test('(b) artifacts/ 아래 깊은 트리 300개가 목록을 덮지 않는다 — 한 덩어리로 접힌다', async () => {
    writeFileSync(join(artifactsDir, 'real.md'), '진짜 산출물');
    const deep = join(artifactsDir, 'scaffold', 'lib');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(artifactsDir, 'scaffold', '.git', 'objects'), { recursive: true });
    for (let i = 0; i < 300; i++) writeFileSync(join(deep, `m${i}.mjs`), 'export const x = 1;');
    writeFileSync(join(artifactsDir, 'scaffold', '.git', 'objects', 'abcd'), 'blob');

    const started = Date.now();
    const stats = await sweep(store, reader);

    expect(stats.scanned).toBe(1);
    expect(stats.bundles).toBe(1);
    // 파일 1 + 번들 1. 300개가 개별 행이 되지 않는 것이 요점이다.
    expect(store.counts().artifacts).toBe(2);
    const bundle = store.db.query('SELECT file_name, bundle_files FROM artifacts WHERE bundle_files IS NOT NULL').get();
    expect(bundle.file_name).toBe('scaffold');
    // .git 내부는 내용물에서 뺀다 — 넣으면 목록과 검색 본문을 뒤덮는다.
    expect(bundle.bundle_files).toBe(300);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('(c) 원본이 사라져도 태그와 메모가 남고 계속 검색된다', async () => {
    const path = join(artifactsDir, 'gone.md');
    writeFileSync(path, '사라질 본문');
    await collectOnce(store, reader);
    const id = store.byPathKey(nfc(path)).id;
    store.addTag(id, '중요');
    store.setNote(id, '이건 지우면 안 됨');

    rmSync(path);
    await sweep(store, reader);

    const row = store.byPathKey(nfc(path));
    expect(row.missing_at).not.toBeNull();
    expect(store.tagsOf(id)).toEqual(['중요']);
    expect(row.note).toBe('이건 지우면 안 됨');
    expect(search(store, '사라질', { includeMissing: true })).toHaveLength(1);
  });

  test('(d) fs.watch 없이 주기 스윕만으로 대조된다', async () => {
    writeFileSync(join(artifactsDir, 'first.md'), '처음');
    // 세션 로그 수집기를 끈다. 켜면 테스트가 실제 홈 디렉터리의 로그를 훑는다.
    const watcher = new Watcher(store, [reader], { periodMs: 10_000, useFsWatch: false, withSessionLogs: false });
    await watcher.start();
    expect(store.counts().artifacts).toBe(1);

    writeFileSync(join(artifactsDir, 'second.md'), '나중');
    rmSync(join(artifactsDir, 'first.md'));
    await watcher.collect();
    watcher.stop();

    expect(store.counts()).toMatchObject({ artifacts: 2, missing: 1 });
    expect(watcher.status().watching).toBe(0);
  });

  test('이름이 바뀌어도 태그를 잃지 않는다 — inode 로 추적한다', async () => {
    const before = join(artifactsDir, 'old-name.md');
    writeFileSync(before, '내용은 그대로');
    await sweep(store, reader);
    const id = store.byPathKey(nfc(before)).id;
    store.addTag(id, '유지');

    renameSync(before, join(artifactsDir, 'new-name.md'));
    await sweep(store, reader);

    expect(store.byPathKey(nfc(join(artifactsDir, 'new-name.md'))).id).toBe(id);
    expect(store.tagsOf(id)).toEqual(['유지']);
    expect(store.counts().artifacts).toBe(1);
  });

  test('확장자가 바뀌는 이름 변경이 분류를 낡은 채로 두지 않는다', async () => {
    const before = join(artifactsDir, 'note.md');
    writeFileSync(before, '내용은 그대로');
    await sweep(store, reader);
    expect(store.byPathKey(nfc(before)).kind).toBe('text');

    renameSync(before, join(artifactsDir, 'note.swift'));
    await sweep(store, reader);

    const row = store.byPathKey(nfc(join(artifactsDir, 'note.swift')));
    expect([row.ext, row.kind]).toEqual(['swift', 'code']);
    expect(store.counts().artifacts).toBe(1);
  });

  test('0바이트 파일은 건너뛴다 — 쓰는 중인 파일이 그렇게 보인다', async () => {
    writeFileSync(join(artifactsDir, 'inflight.md'), '');
    expect((await sweep(store, reader)).inserted).toBe(0);
  });

  test('제자리 편집은 같은 행을 갱신하고 태그를 보존한다', async () => {
    const path = join(artifactsDir, 'edit.md');
    writeFileSync(path, '처음 내용');
    await sweep(store, reader);
    const id = store.byPathKey(nfc(path)).id;
    store.addTag(id, '작업중');
    const firstHash = store.byPathKey(nfc(path)).content_hash;

    writeFileSync(path, '고친 내용');
    const stats = await sweep(store, reader);

    expect(stats.updated).toBe(1);
    expect(store.byPathKey(nfc(path)).id).toBe(id);
    expect(store.byPathKey(nfc(path)).content_hash).not.toBe(firstHash);
    expect(store.tagsOf(id)).toEqual(['작업중']);
  });
});

describe('보강 — state.db 조인', () => {
  test('산출물 플래그가 붙은 것만 final 이 된다', async () => {
    writeFileSync(join(artifactsDir, 'deliverable.md'), '최종 산출물');
    writeFileSync(join(artifactsDir, 'side.md'), '곁다리');
    buildStateDb([
      { filesChanged: JSON.stringify([{ type: 'created', path: 'artifacts/deliverable.md', artifact: { sizeBytes: 11 } }]) },
      { filesChanged: JSON.stringify([{ type: 'created', path: 'artifacts/side.md' }]) },
    ]);

    await collectOnce(store, reader);
    expect(store.byPathKey(nfc(join(artifactsDir, 'deliverable.md'))).state).toBe('final');
    expect(store.byPathKey(nfc(join(artifactsDir, 'side.md'))).state).toBe('discovered');
  });

  test('사용자가 정한 상태는 이후 보강이 덮어쓰지 못한다', async () => {
    writeFileSync(join(artifactsDir, 'd.md'), '내용');
    buildStateDb([{ filesChanged: JSON.stringify([{ type: 'created', path: 'artifacts/d.md', artifact: { sizeBytes: 6 } }]) }]);
    await collectOnce(store, reader);
    const id = store.byPathKey(nfc(join(artifactsDir, 'd.md'))).id;

    store.setUserState(id, 'discovered');
    store.setState('aside.turn_cursor', 0);
    await enrich(store, reader);

    expect(store.byPathKey(nfc(join(artifactsDir, 'd.md'))).state).toBe('discovered');
  });

  test('깨진 JSON 한 행이 나머지 행을 삼키지 않는다 — json_valid 가드', async () => {
    writeFileSync(join(artifactsDir, 'before.md'), '앞');
    writeFileSync(join(artifactsDir, 'after.md'), '뒤');
    buildStateDb([
      { filesChanged: JSON.stringify([{ type: 'created', path: 'artifacts/before.md', artifact: { sizeBytes: 3 } }]) },
      { filesChanged: '{{{ 깨진 JSON' },
      { filesChanged: JSON.stringify([{ type: 'created', path: 'artifacts/after.md', artifact: { sizeBytes: 3 } }]) },
    ]);

    await collectOnce(store, reader);
    expect(store.byPathKey(nfc(join(artifactsDir, 'before.md'))).state).toBe('final');
    expect(store.byPathKey(nfc(join(artifactsDir, 'after.md'))).state).toBe('final');
  });

  test('tmp/ 와 경로 탈출은 플래그가 있어도 수집되지 않는다', async () => {
    mkdirSync(join(dir, 'u0', 'sessions', SESSION_DIR, 'tmp'), { recursive: true });
    writeFileSync(join(dir, 'u0', 'sessions', SESSION_DIR, 'tmp', 'scratch.txt'), '스크래치');
    buildStateDb([
      { filesChanged: JSON.stringify([
        { type: 'created', path: 'tmp/scratch.txt', artifact: { sizeBytes: 5 } },
        { type: 'created', path: '../../../etc/passwd', artifact: { sizeBytes: 5 } },
      ]) },
    ]);

    await collectOnce(store, reader);
    expect(store.counts().artifacts).toBe(0);
  });

  test('커서가 진행하면 같은 행을 다시 처리하지 않는다', async () => {
    writeFileSync(join(artifactsDir, 'a.md'), '내용');
    buildStateDb([{ filesChanged: JSON.stringify([{ type: 'created', path: 'artifacts/a.md', artifact: { sizeBytes: 6 } }]) }]);
    await collectOnce(store, reader);
    expect(Number(store.getState('aside.turn_cursor'))).toBe(1);
    expect((await enrich(store, reader)).rows).toBe(0);
  });

  test('state.db 가 없어도 파일시스템 수집은 계속된다', async () => {
    writeFileSync(join(artifactsDir, 'a.md'), '내용');
    const result = await collectOnce(store, reader);
    expect(result.swept.inserted).toBe(1);
    expect(result.enriched.rows).toBe(0);
  });
});

describe('V4 — NFC/NFD 조인', () => {
  const NFD_NAME = '홍길동_이력서_초안.md'.normalize('NFD');
  const NFC_NAME = '홍길동_이력서_초안.md'.normalize('NFC');

  test('디스크가 NFD 를 돌려줘도 NFC 경로로 같은 행을 찾는다', async () => {
    writeFileSync(join(artifactsDir, NFD_NAME), '이력서 본문');
    const onDisk = readdirSync(artifactsDir)[0];
    await sweep(store, reader);

    // 이 단언이 깨지면 한글 아티팩트가 영원히 discovered 에 머문다 — 에러 없이.
    expect(store.byPathKey(nfc(join(artifactsDir, onDisk)))).toBeTruthy();
    expect(store.byPathKey(nfc(join(artifactsDir, NFC_NAME)))).toBeTruthy();
    expect(store.counts().artifacts).toBe(1);
  });

  test('files_changed 의 NFC 경로가 NFD 로 저장된 파일에 붙는다', async () => {
    writeFileSync(join(artifactsDir, NFD_NAME), '이력서 본문');
    buildStateDb([
      { filesChanged: JSON.stringify([{ type: 'created', path: `artifacts/${NFC_NAME}`, artifact: { sizeBytes: 12 } }]) },
    ]);

    await collectOnce(store, reader);
    expect(store.counts()).toMatchObject({ artifacts: 1, final: 1, enriched: 1 });
  });
});

describe('번들 — 프로젝트 폴더를 한 줄로', () => {
  test('내용물 파일명으로 번들을 찾는다', async () => {
    const proj = join(artifactsDir, 'gen-app');
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'package.json'), '{}');
    writeFileSync(join(proj, 'src', 'renderer.mjs'), 'export const x = 1;');
    await collectOnce(store, reader);

    const { search } = await import('../lib/search.mjs');
    expect(search(store, 'renderer.mjs').map((r) => r.file_name)).toEqual(['gen-app']);
  });

  test('내용물이 바뀌면 같은 행이 갱신된다', async () => {
    const proj = join(artifactsDir, 'gen-app');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'package.json'), '{}');
    writeFileSync(join(proj, 'a.txt'), 'one');
    await sweep(store, reader);
    const first = store.db.query('SELECT id, content_hash, bundle_files FROM artifacts WHERE bundle_files IS NOT NULL').get();

    writeFileSync(join(proj, 'b.txt'), 'two');
    await sweep(store, reader);
    const second = store.db.query('SELECT id, content_hash, bundle_files FROM artifacts WHERE bundle_files IS NOT NULL').get();

    expect(second.id).toBe(first.id);
    expect(second.bundle_files).toBe(3);
    expect(second.content_hash).not.toBe(first.content_hash);
  });

  test('빌드 산출물 폴더는 내용물에서 빠진다', async () => {
    const proj = join(artifactsDir, 'gen-app');
    mkdirSync(join(proj, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(proj, '.git'), { recursive: true });
    writeFileSync(join(proj, 'index.mjs'), 'x');
    writeFileSync(join(proj, 'node_modules', 'dep', 'index.js'), 'x');
    writeFileSync(join(proj, '.git', 'HEAD'), 'x');
    await sweep(store, reader);

    expect(store.db.query('SELECT bundle_files FROM artifacts WHERE bundle_files IS NOT NULL').get().bundle_files).toBe(1);
  });

  test('tab-previews 는 번들이 아니라 개별 파일로 수집한다', async () => {
    mkdirSync(join(artifactsDir, 'tab-previews'), { recursive: true });
    writeFileSync(join(artifactsDir, 'tab-previews', 'shot.png'), 'x');
    await sweep(store, reader);

    expect(store.db.query('SELECT COUNT(*) n FROM artifacts WHERE bundle_files IS NOT NULL').get().n).toBe(0);
    expect(store.counts().artifacts).toBe(1);
  });
});

describe('작은 폴더는 접지 않는다', () => {
  const names = () => store.db.query('SELECT file_name FROM artifacts ORDER BY file_name').all().map((r) => r.file_name);

  test('산출물 몇 개를 담은 폴더는 파일로 올라온다 — 한 줄 뒤로 사라지던 실패', async () => {
    const dir = join(artifactsDir, 'drawio-visual-audit');
    mkdirSync(dir, { recursive: true });
    for (const name of ['fidelity-aggregate.json', 'in-confluence.png', 'iv-confluence.png', 'tech-confluence.png']) {
      writeFileSync(join(dir, name), name);
    }
    await sweep(store, reader);

    expect(store.db.query('SELECT COUNT(*) n FROM artifacts WHERE bundle_files IS NOT NULL').get().n).toBe(0);
    expect(names()).toEqual(['fidelity-aggregate.json', 'in-confluence.png', 'iv-confluence.png', 'tech-confluence.png']);
  });

  test('펴도 점 파일은 받지 않는다 — 최상위와 같은 규칙', async () => {
    const dir = join(artifactsDir, 'drawio-visual-audit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.DS_Store'), 'x');
    writeFileSync(join(dir, 'report.png'), 'x');
    await sweep(store, reader);

    expect(names()).toEqual(['report.png']);
  });

  test('파일 하나짜리 폴더도 그 파일이 된다', async () => {
    mkdirSync(join(artifactsDir, 'drawio-fidelity-final', 'inner'), { recursive: true });
    writeFileSync(join(artifactsDir, 'drawio-fidelity-final', 'inner', 'iv-inner.png'), 'x');
    await sweep(store, reader);

    expect(names()).toEqual(['iv-inner.png']);
  });

  test('파일이 많으면 접는다 — 대량으로 받은 첨부가 목록을 뒤덮지 않게', async () => {
    const dir = join(artifactsDir, 'rack-mesh-drawio-latest-30');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < BUNDLE_MIN_FILES; i++) writeFileSync(join(dir, `IN-${i}.drawio`), '<mxfile/>');
    await sweep(store, reader);

    expect(names()).toEqual(['rack-mesh-drawio-latest-30']);
  });

  test('프로젝트 표지가 있으면 파일이 적어도 접는다 — 스캐폴딩은 산출물이 아니다', async () => {
    const dir = join(artifactsDir, 'gen-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'index.mjs'), 'x');
    await sweep(store, reader);

    expect(names()).toEqual(['gen-app']);
  });
});

describe('세션이 아는 제목은 files_changed 가 없어도 붙는다', () => {
  test('파일은 썼는데 그 기록이 없는 세션도 제목과 공급자를 갖는다 — 트리에서 익명 더미가 되던 실패', async () => {
    writeFileSync(join(artifactsDir, 'note.md'), '내용');
    // 세션은 있고 제목도 있는데 files_changed 가 빈 경우. 보강의 조인으로는 제목을 못 얻는다.
    buildStateDb([{ filesChanged: JSON.stringify([]) }]);

    await sweep(store, reader);
    const [origin] = store.originsOf(store.byPathKey(nfc(join(artifactsDir, 'note.md'))).id);
    expect([origin.session_title, origin.provider]).toEqual(['테스트 세션', 'claude-code']);
  });

  test('Aside DB 에 없는 세션은 제목 없이 남는다 — 지어내지 않는다', async () => {
    writeFileSync(join(artifactsDir, 'orphan.md'), '내용');
    await sweep(store, reader);
    const [origin] = store.originsOf(store.byPathKey(nfc(join(artifactsDir, 'orphan.md'))).id);
    expect([origin.session_title, origin.provider]).toEqual([null, null]);
  });
});

describe('폴더를 파일로 넘기지 않는다 — sweep_failed EISDIR 의 원인', () => {
  test('보강이 산출물 표시가 붙은 폴더를 만나도 수집이 멈추지 않는다', async () => {
    // 에이전트가 artifacts/ 안에 폴더를 만들고 state.db 가 거기에 산출물 표시를 붙인 경우.
    mkdirSync(join(artifactsDir, 'gen-app'), { recursive: true });
    buildStateDb([{ filesChanged: JSON.stringify([{ path: 'artifacts/gen-app', type: 'write', artifact: { sizeBytes: 12 } }]) }]);

    const stats = await enrich(store, reader);
    expect(stats.widened).toBe(0);
    expect(store.byPathKey(nfc(join(artifactsDir, 'gen-app')))).toBeNull();
  });

  test('작업공간 문서 수집이 폴더를 건너뛴다 — fs.watch 는 폴더 생성도 알린다', async () => {
    const docs = join(dir, 'repo', 'docs.md');
    mkdirSync(docs, { recursive: true });
    expect(await ingestWorkspaceDoc(store, docs, join(dir, 'repo'))).toEqual({ rule: 'skipped-not-file' });
    expect(store.counts().artifacts).toBe(0);
  });
});
