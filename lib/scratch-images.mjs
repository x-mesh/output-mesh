import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_PROFILE_MARKER, BUILD_ARTIFACT_DIRS, PROJECT_MARKERS, SCRATCH_SCAN_MAX_DEPTH } from './paths.mjs';
import { KIND, kindOf } from './extract.mjs';
import { extOf } from './scanner.mjs';

/**
 * Claude Code 세션 작업 폴더(`<root>/<프로젝트>/<세션 id>/scratchpad/`)의 이미지. 에이전트가 스크립트로 찍은
 * 스크린샷이 여기 남는데 Write 도구로 쓰지 않아서 로그에 경로가 없다. 실측 작업 폴더 193개에서 라이브러리
 * 종류 3,993개가 나왔지만 문서는 PR 본문 · 리뷰 메모 · 로그였고, 볼 만한 것은 이미지 248개였다.
 *
 * 복제한 저장소와 브라우저 프로필은 에이전트가 만든 그림이 아니라서 통째로 건너뛴다. 실측 이미지 1,983개 중
 * 1,735개가 그 안(캐시 아이콘, 저장소 자산)에 있었다. 작업 폴더 자신은 표지가 있어도 훑는다.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const foreign = (dir) => existsSync(join(dir, BROWSER_PROFILE_MARKER)) || PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function walk(dir, depth, sessionRef, found) {
  if (depth > SCRATCH_SCAN_MAX_DEPTH || (depth > 0 && foreign(dir))) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!BUILD_ARTIFACT_DIRS.includes(entry.name)) walk(path, depth + 1, sessionRef, found);
    } else if (entry.isFile() && kindOf(extOf(entry.name), entry.name) === KIND.IMAGE) {
      found.push({ path, sessionRef });
    }
  }
}

export function scratchImages(root) {
  const found = [];
  for (const project of listDirs(root)) {
    for (const session of listDirs(join(root, project.name))) {
      if (SESSION_ID.test(session.name)) walk(join(root, project.name, session.name, 'scratchpad'), 0, session.name, found);
    }
  }
  return found;
}
