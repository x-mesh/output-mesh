import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export const DEFAULT_PORT = 19843;
export const DEFAULT_HOST = '127.0.0.1';

export const ASIDE_HOME = join(homedir(), '.aside');
export const ASIDE_ACCOUNTS_DIR = join(ASIDE_HOME, 'u');

export const CATALOG_DIR = join(homedir(), 'Library', 'Application Support', 'AgentOutputCatalog');
export const CATALOG_DB = join(CATALOG_DIR, 'catalog.db');

export const ARTIFACTS_DIR_NAME = 'artifacts';
export const COLLECTIBLE_SUBDIRS = ['tab-previews'];
export const EXCLUDED_DIR_NAMES = ['tmp', 'attachments'];

// 이 파일들이 있으면 디렉터리 하나를 프로젝트로 본다. 에이전트가 산출물 폴더 안에
// 저장소를 통째로 만들어도 목록에는 한 줄로 올라간다.
export const PROJECT_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'Package.swift', 'pyproject.toml', 'go.mod'];
export const MAX_BUNDLE_MEMBERS = 5000;
// 번들 내용 목록에서 뺀다. 넣으면 .git 내부가 목록과 검색 본문을 뒤덮는다.
export const BUILD_ARTIFACT_DIRS = ['.git', 'node_modules', 'target', 'dist', 'build', '.build', '.next', '__pycache__', '.venv', 'venv', 'coverage', '.cache'];

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_INDEXED_BODY_BYTES = 256 * 1024;
// 목록 한 줄에 들어갈 부제 길이. 프런트매터 description 은 수백 자가 되기도 한다.
export const TITLE_MAX_CHARS = 160;
// 이보다 짧은 작업 제목은 대개 "계속"·"ok" 같은 이어가기 말이라 무엇을 했는지 말하지 않는다.
export const MIN_TASK_CHARS = 6;
// xlsx 미리보기는 앞부분만 표로 보인다. 한 시트 XML 이 3.6 MB 인 파일이 실재한다 — 전부 그리면
// 화면이 굳는다. 행은 순서대로 적히므로 앞 몇 MB 만 풀면 처음 행들이 다 들어 있다.
export const SHEET_PREVIEW_ROWS = 200;
export const SHEET_PREVIEW_COLS = 30;
export const SHEET_PREVIEW_XML_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_SHEETS = 20;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export const BINARY_SNIFF_BYTES = 8 * 1024;

export const PERIODIC_SWEEP_MS = 30_000;
export const WATCH_DEBOUNCE_MS = 3_000;
export const ENRICH_INTERVAL_MS = 300_000;
export const EXTRACT_TIMEOUT_MS = 5_000;
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
// 첫 수집을 기다리는 동안 스피너가 한 프레임을 보이는 시간.
export const SPINNER_FRAME_MS = 80;
// 동기 로그 파싱이 이벤트 루프를 이만큼 붙잡으면 한 번 양보한다. 신호 처리기(Ctrl-C)와
// 스피너 타이머, 서버가 뜬 뒤의 HTTP 요청이 이 간격 안에 차례를 얻는다.
export const COLLECT_YIELD_MS = 50;
// 세션 로그를 읽는 조각 크기. 로그 하나가 200MB 를 넘기도 해서 통째로 올리지 않는다.
export const LOG_READ_CHUNK_BYTES = 8 * 1024 * 1024;

// trigram 토크나이저는 3자 미만 쿼리에 에러 없이 0건을 반환한다. 그 아래는 LIKE로 우회한다.
export const MIN_FTS_TOKEN_CHARS = 3;
// 목록 기본 상한. 탐색기 트리는 라이브러리 전체를 한 번에 받아 저장소별로 묶어야 해서
// 더 크게 요청할 수 있지만, 클라이언트가 준 값은 이 천장에서 자른다.
export const DEFAULT_SEARCH_LIMIT = 200;
export const MAX_SEARCH_LIMIT = 5_000;
// 기간 선택. 값은 "오늘을 포함해 며칠"이고 지역 자정에서 자른다 — 7일은 엿새 전 자정부터다.
// 목록·패싯·현황·그래프·활동이 모두 이 표 하나로 시작 시각을 얻는다.
export const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
// 상단 현황 숫자. "요즘 무엇을 했나"는 기간 선택의 7일과 같은 조건이라 누르면 그 기간이 된다.
export const OVERVIEW_RECENT_PERIOD = '7d';
export const OVERVIEW_ACTIVE_HOURS = 24;
// 기간이 '전체'면 그래프는 주 단위다. 두 해를 넘기면 막대가 1px 보다 가늘어진다.
export const MAX_TIMELINE_WEEKS = 104;
// 변경 기록은 "방금 일어난 일"을 보이려는 것이다. 한 달이 지난 줄은 지운다 — 서버를 계속 켜 두면
// 30초마다 쌓여 끝없이 자란다.
export const EVENT_RETENTION_DAYS = 30;
export const DEFAULT_CHANGE_LIMIT = 20;
export const MAX_CHANGE_LIMIT = 100;
// 에이전트가 셸로 쓴 문서는 로그에 경로가 없다. 에이전트가 일한 저장소에서 라이브러리 종류의 파일을
// 직접 찾는다. 처음 한 번은 이 기간 안에 바뀐 것만 넣는다 — 전부 넣으면 라이브러리가 저장소 문서
// 전체(실측 3,685개)가 된다. 7일이면 88개, 30일이면 약 200개였다.
export const WORKSPACE_BACKFILL_DAYS = 7;
// 깊이와 개수에 상한을 둔다. 큰 저장소(파일 10만 개)도 한 번 훑는 데 1초 안팎이다.
export const WORKSPACE_SCAN_MAX_DEPTH = 8;
export const WORKSPACE_SCAN_MAX_FILES = 300_000;

/** macOS readdir은 NFD를, 소스 리터럴과 SQLite 값은 NFC를 준다. 비교는 항상 이 형태로만. */
export function nfc(value) {
  return value.normalize('NFC');
}

export function asideAccountDirs(root = ASIDE_ACCOUNTS_DIR) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

export function asideSessionsRoot(accountDir) {
  return join(accountDir, 'sessions');
}

export function asideStateDb(accountDir) {
  return join(accountDir, 'state.db');
}
