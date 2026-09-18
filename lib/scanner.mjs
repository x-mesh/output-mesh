import { ARTIFACTS_DIR_NAME, COLLECTIBLE_SUBDIRS, EXCLUDED_DIR_NAMES, nfc } from './paths.mjs';

export const REJECT = {
  NOT_ARTIFACTS: 'not-artifacts-dir',
  EXCLUDED_DIR: 'excluded-dir',
  TOO_DEEP: 'too-deep',
  DOTFILE: 'dotfile',
  UNSAFE_PATH: 'unsafe-path',
};

/** 세션 디렉터리명은 `<YYYY-MM-DD>_<sessionId>`. 날짜에는 `_`가 없지만 세션 id에는 있을 수 있어 마지막 `_`로 쪼갠다. */
export function splitSessionDirName(name) {
  const cut = name.lastIndexOf('_');
  if (cut <= 0) return null;
  return { date: name.slice(0, cut), sessionId: name.slice(cut + 1) };
}

function unsafe(segments) {
  return segments.some((s) => s === '' || s === '.' || s === '..');
}

/**
 * 세션 루트 기준 상대 경로 하나를 분류한다. 파일시스템을 만지지 않는 순수 함수라
 * 실제 경로 목록을 픽스처로 박아 테스트할 수 있다.
 */
export function classifyRelPath(relPath) {
  if (relPath.startsWith('/')) return { collect: false, reason: REJECT.UNSAFE_PATH };
  const segments = nfc(relPath).split('/');
  if (unsafe(segments)) return { collect: false, reason: REJECT.UNSAFE_PATH };
  if (segments.length < 3) return { collect: false, reason: REJECT.NOT_ARTIFACTS };

  const [sessionDir, bucket, ...rest] = segments;
  if (!splitSessionDirName(sessionDir)) return { collect: false, reason: REJECT.NOT_ARTIFACTS };
  if (EXCLUDED_DIR_NAMES.includes(bucket)) return { collect: false, reason: REJECT.EXCLUDED_DIR };
  if (bucket !== ARTIFACTS_DIR_NAME) return { collect: false, reason: REJECT.NOT_ARTIFACTS };
  if (rest.some((s) => s.startsWith('.'))) return { collect: false, reason: REJECT.DOTFILE };

  if (rest.length === 1) return { collect: true, sessionDir, relInArtifacts: rest[0] };
  if (rest.length === 2 && COLLECTIBLE_SUBDIRS.includes(rest[0])) {
    return { collect: true, sessionDir, relInArtifacts: rest.join('/') };
  }
  return { collect: false, reason: REJECT.TOO_DEEP };
}

/**
 * 워처가 받은 디렉터리가 열거 대상인지. `artifacts/card/.git/objects/ab` 같은 경로를
 * stat 이전에 문자열 비교만으로 거부한다.
 */
export function isCollectibleDir(relDirPath) {
  const segments = nfc(relDirPath).split('/').filter((s) => s !== '');
  if (unsafe(segments)) return false;
  if (segments.length === 2) return segments[1] === ARTIFACTS_DIR_NAME && !!splitSessionDirName(segments[0]);
  if (segments.length === 3) {
    return (
      segments[1] === ARTIFACTS_DIR_NAME &&
      COLLECTIBLE_SUBDIRS.includes(segments[2]) &&
      !!splitSessionDirName(segments[0])
    );
  }
  return false;
}

/** files_changed 의 경로는 세션 디렉터리 기준이라 앞에 세션 디렉터리명을 붙여 판정한다. */
export function classifyFilesChangedPath(sessionDirName, pathInSession) {
  if (pathInSession.startsWith('/')) return { collect: false, reason: REJECT.UNSAFE_PATH };
  return classifyRelPath(`${sessionDirName}/${pathInSession}`);
}

export function extOf(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot + 1).toLowerCase();
}
