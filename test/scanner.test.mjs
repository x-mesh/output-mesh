import { describe, expect, test } from 'bun:test';
import { classifyRelPath, classifyFilesChangedPath, isCollectibleDir, splitSessionDirName, extOf, REJECT } from '../lib/scanner.mjs';

const S = '2026-09-11_LQIXe9g5mhi6tWDo';

describe('splitSessionDirName', () => {
  test('마지막 _ 로 쪼갠다', () => {
    expect(splitSessionDirName(S)).toEqual({ date: '2026-09-11', sessionId: 'LQIXe9g5mhi6tWDo' });
  });
  test('세션 id 안에 _ 가 있어도 날짜를 잃지 않는다', () => {
    expect(splitSessionDirName('2026-09-11_a_b')).toEqual({ date: '2026-09-11_a', sessionId: 'b' });
  });
  test('구분자가 없으면 세션 디렉터리가 아니다', () => {
    expect(splitSessionDirName('notasession')).toBeNull();
  });
});

describe('classifyRelPath — 수집', () => {
  test.each([
    `${S}/artifacts/agent-output-catalog-prd.md`,
    `${S}/artifacts/2024-01_2024-12_분기별_매출흐름.xlsx`,
    `${S}/artifacts/홍길동_이력서_초안.md`,
    `${S}/artifacts/rack-3d-sketch.html`,
    `${S}/artifacts/tab-previews/shot.png`,
  ])('%s', (p) => {
    expect(classifyRelPath(p).collect).toBe(true);
  });
});

describe('classifyRelPath — 거부', () => {
  test.each([
    [`${S}/artifacts/card/package.json`, REJECT.TOO_DEEP],
    [`${S}/artifacts/card/.git/objects/ab/cd`, REJECT.DOTFILE],
    [`${S}/artifacts/layers-card/render.mjs`, REJECT.TOO_DEEP],
    [`${S}/artifacts/.DS_Store`, REJECT.DOTFILE],
    [`${S}/attachments/Resume.pdf`, REJECT.EXCLUDED_DIR],
    [`${S}/tmp/websearch-result-1.txt`, REJECT.EXCLUDED_DIR],
    [`${S}/messages.jsonl`, REJECT.NOT_ARTIFACTS],
    [`${S}/artifacts/../../etc/passwd`, REJECT.UNSAFE_PATH],
    ['/etc/passwd', REJECT.UNSAFE_PATH],
    ['notasession/artifacts/x.md', REJECT.NOT_ARTIFACTS],
  ])('%s -> %s', (p, reason) => {
    const got = classifyRelPath(p);
    expect(got.collect).toBe(false);
    expect(got.reason).toBe(reason);
  });
});

describe('isCollectibleDir — stat 이전에 문자열로 거부', () => {
  test.each([
    [`${S}/artifacts`, true],
    [`${S}/artifacts/tab-previews`, true],
    [`${S}/artifacts/card`, false],
    [`${S}/artifacts/card/.git/objects`, false],
    [`${S}/tmp`, false],
    [`${S}`, false],
  ])('%s -> %s', (dir, want) => {
    expect(isCollectibleDir(dir)).toBe(want);
  });
});

describe('classifyFilesChangedPath', () => {
  test('세션 기준 상대 경로를 세션 디렉터리에 붙여 판정한다', () => {
    expect(classifyFilesChangedPath(S, 'artifacts/a.md').collect).toBe(true);
    expect(classifyFilesChangedPath(S, 'tmp/a.txt').collect).toBe(false);
  });
  test('절대 경로는 조인 전에 거부한다', () => {
    expect(classifyFilesChangedPath(S, '/etc/passwd').reason).toBe(REJECT.UNSAFE_PATH);
  });
});

describe('extOf', () => {
  test.each([['a.md', 'md'], ['A.XLSX', 'xlsx'], ['Makefile', ''], ['.gitignore', ''], ['a.', '']])(
    '%s -> "%s"',
    (name, want) => expect(extOf(name)).toBe(want),
  );
});
