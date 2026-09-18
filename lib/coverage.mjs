import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ARTIFACTS_DIR_NAME, EXCLUDED_DIR_NAMES } from './paths.mjs';
import { classifyRelPath, REJECT, splitSessionDirName } from './scanner.mjs';

export const REASON_LABEL = {
  [REJECT.TOO_DEEP]: '중첩 폴더 (스캐폴딩된 프로젝트)',
  [REJECT.DOTFILE]: '점으로 시작하는 파일 (.git 등)',
  [REJECT.EXCLUDED_DIR]: '제외 폴더 (tmp · attachments)',
  [REJECT.NOT_ARTIFACTS]: '산출물 폴더 밖 (transcript 등)',
  [REJECT.UNSAFE_PATH]: '안전하지 않은 경로',
  symlink: '심볼릭 링크',
  empty: '0바이트',
};

/**
 * 수집 범위를 사람이 검증할 수 있게 만든다. "왜 이것밖에 안 잡혔나"에 답하는 용도라
 * 스윕 경로에서 부르지 않는다 — 세션 트리 전체를 걷기 때문이다.
 */
export function surveyCoverage(sessionsRoot) {
  const survey = {
    sessions: { total: 0, withArtifacts: 0, empty: 0 },
    collected: 0,
    excluded: {},
    byBucket: {},
    largestGroups: [],
  };
  if (!existsSync(sessionsRoot)) return survey;

  const groupSizes = new Map();
  const bump = (bag, key, by = 1) => {
    bag[key] = (bag[key] ?? 0) + by;
  };

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        bump(survey.excluded, 'symlink');
        continue;
      }
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const rel = relative(sessionsRoot, path);
      const segments = rel.split('/');
      bump(survey.byBucket, segments.length > 1 ? segments[1] : '(세션 루트)');

      const verdict = classifyRelPath(rel);
      if (verdict.collect) {
        survey.collected++;
        continue;
      }
      bump(survey.excluded, verdict.reason);
      if (verdict.reason === REJECT.TOO_DEEP || verdict.reason === REJECT.DOTFILE) {
        const inArtifacts = segments.slice(2);
        if (inArtifacts.length > 1) {
          const group = `${segments[0]}/${inArtifacts[0]}`;
          groupSizes.set(group, (groupSizes.get(group) ?? 0) + 1);
        }
      }
    }
  };

  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !splitSessionDirName(entry.name)) continue;
    survey.sessions.total++;
    const sessionDir = join(sessionsRoot, entry.name);
    const artifactsDir = join(sessionDir, ARTIFACTS_DIR_NAME);
    const hasArtifacts =
      existsSync(artifactsDir) && readdirSync(artifactsDir).some((name) => !name.startsWith('.'));
    if (hasArtifacts) survey.sessions.withArtifacts++;
    else survey.sessions.empty++;
    walk(sessionDir);
  }

  survey.largestGroups = [...groupSizes.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 5);
  survey.excludedTotal = Object.values(survey.excluded).reduce((a, b) => a + b, 0);
  survey.excludedDirNames = EXCLUDED_DIR_NAMES;
  return survey;
}
