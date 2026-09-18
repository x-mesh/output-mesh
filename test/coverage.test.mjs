import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surveyCoverage, REASON_LABEL } from '../lib/coverage.mjs';
import { REJECT } from '../lib/scanner.mjs';

let root;
const session = (name) => {
  const dir = join(root, name);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  return dir;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a-out-coverage-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('수집 범위 조사', () => {
  test('산출물이 있는 세션과 빈 세션을 구분한다 — "왜 이것밖에 없나"의 첫 번째 답', () => {
    const withFiles = session('2026-01-01_AAA');
    writeFileSync(join(withFiles, 'artifacts', 'a.md'), '내용');
    session('2026-01-02_BBB');
    session('2026-01-03_CCC');

    const survey = surveyCoverage(root);
    expect(survey.sessions).toEqual({ total: 3, withArtifacts: 1, empty: 2 });
    expect(survey.collected).toBe(1);
  });

  test('제외 이유별로 집계하고 전부 사람이 읽을 이름을 갖는다', () => {
    const dir = session('2026-01-01_AAA');
    writeFileSync(join(dir, 'messages.jsonl'), '{}');
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    writeFileSync(join(dir, 'tmp', 'scratch.txt'), 'x');
    mkdirSync(join(dir, 'artifacts', 'proj', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'proj', 'lib', 'a.mjs'), 'x');
    writeFileSync(join(dir, 'artifacts', '.DS_Store'), 'x');

    const survey = surveyCoverage(root);
    expect(survey.excluded[REJECT.NOT_ARTIFACTS]).toBe(1);
    expect(survey.excluded[REJECT.EXCLUDED_DIR]).toBe(1);
    expect(survey.excluded[REJECT.TOO_DEEP]).toBe(1);
    expect(survey.excluded[REJECT.DOTFILE]).toBe(1);
    expect(survey.excludedTotal).toBe(4);
    for (const reason of Object.keys(survey.excluded)) expect(REASON_LABEL[reason]).toBeTruthy();
  });

  test('제외된 최대 묶음을 짚어준다 — 스캐폴딩 프로젝트가 수백 개를 차지한 걸 설명한다', () => {
    const dir = session('2026-01-01_AAA');
    mkdirSync(join(dir, 'artifacts', 'scaffold', 'lib'), { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, 'artifacts', 'scaffold', 'lib', `m${i}.mjs`), 'x');
    mkdirSync(join(dir, 'artifacts', 'small'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'small', 'one.mjs'), 'x');

    const survey = surveyCoverage(root);
    expect(survey.largestGroups[0]).toEqual({ name: '2026-01-01_AAA/scaffold', files: 12 });
    expect(survey.largestGroups[1].files).toBe(1);
  });

  test('버킷별 파일 수를 낸다 — tmp 가 artifacts 보다 클 수 있다는 걸 보여준다', () => {
    const dir = session('2026-01-01_AAA');
    writeFileSync(join(dir, 'artifacts', 'a.md'), 'x');
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, 'tmp', `t${i}.txt`), 'x');

    const survey = surveyCoverage(root);
    expect(survey.byBucket).toMatchObject({ artifacts: 1, tmp: 5 });
  });

  test('심볼릭 링크는 따라가지 않고 따로 센다', () => {
    const dir = session('2026-01-01_AAA');
    writeFileSync(join(dir, 'artifacts', 'real.md'), 'x');
    symlinkSync(join(dir, 'artifacts', 'real.md'), join(dir, 'artifacts', 'link.md'));

    const survey = surveyCoverage(root);
    expect(survey.collected).toBe(1);
    expect(survey.excluded.symlink).toBe(1);
  });

  test('세션 이름 규칙을 따르지 않는 폴더는 세지 않는다', () => {
    mkdirSync(join(root, 'notasession', 'artifacts'), { recursive: true });
    writeFileSync(join(root, 'notasession', 'artifacts', 'a.md'), 'x');
    expect(surveyCoverage(root).sessions.total).toBe(0);
  });

  test('경로가 없으면 빈 조사 결과를 준다', () => {
    expect(surveyCoverage(join(root, 'nope')).sessions.total).toBe(0);
  });
});
