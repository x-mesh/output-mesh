import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILD_ARTIFACT_DIRS, PROJECT_MARKERS, WORKSPACE_SCAN_MAX_DEPTH } from './paths.mjs';
import { kindOf } from './extract.mjs';
import { extOf } from './scanner.mjs';
import { LIBRARY_HIDDEN_KINDS } from './search.mjs';

/**
 * 에이전트가 셸로 쓴 문서와 사람이 고친 문서는 에이전트 로그에 경로가 없다. 에이전트가 일한
 * 저장소에서 라이브러리 종류의 파일을 직접 찾는다. 이렇게 찾은 파일은 에이전트가 만들었다고
 * 말하지 않는다 — 출처는 이 수집기 하나이고 세션도 공급자도 없다.
 */
export const WORKSPACE_COLLECTOR = 'workspace';

/**
 * 작업공간 안 상대 경로가 라이브러리 문서인가. 종류 판단은 라이브러리와 같은 kindOf 로 한다 —
 * 확장자 목록을 따로 두면 두 규칙이 갈라진다. 점으로 시작하는 폴더(.git, .xm, .claude)와 빌드
 * 산출물 폴더는 뺀다.
 */
export function isWorkspaceDoc(relPath) {
  const parts = relPath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (parts.length - 1 > WORKSPACE_SCAN_MAX_DEPTH) return false;
  if (parts.some((part) => part.startsWith('.'))) return false;
  if (parts.slice(0, -1).some((part) => BUILD_ARTIFACT_DIRS.includes(part))) return false;
  const name = parts.at(-1);
  return !LIBRARY_HIDDEN_KINDS.includes(kindOf(extOf(name), name));
}

/**
 * 훑을 작업공간. 홈 자체나 홈 밖은 빼고(에이전트를 홈에서 켜면 홈 전체를 뒤지게 된다), 프로젝트
 * 표지가 있는 곳만 고른다. 다른 작업공간 안에 든 것은 바깥 하나를 훑으면 같이 훑인다.
 */
export function projectWorkspaces(store, home = homedir()) {
  const candidates = store.db
    .query('SELECT DISTINCT workspace FROM artifact_origins WHERE workspace IS NOT NULL')
    .all()
    .map((row) => row.workspace)
    .filter((ws) => ws.startsWith(`${home}/`) && existsSync(ws) && PROJECT_MARKERS.some((marker) => existsSync(join(ws, marker))));
  return candidates.filter((ws) => !candidates.some((other) => other !== ws && ws.startsWith(`${other}/`))).sort();
}
