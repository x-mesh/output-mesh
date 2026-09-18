import { DEFAULT_CHANGE_LIMIT, DEFAULT_SEARCH_LIMIT, MAX_TIMELINE_WEEKS, MIN_FTS_TOKEN_CHARS, OVERVIEW_ACTIVE_HOURS, OVERVIEW_RECENT_PERIOD, PERIOD_DAYS, nfc } from './paths.mjs';
import { KIND } from './extract.mjs';
import { describe } from './describe.mjs';

const KIND_CODE = KIND.CODE;
const KIND_OTHER = KIND.OTHER;
/** 라이브러리가 기본으로 숨기는 종류. 사이드바가 '라이브러리 밖'으로 표시한다. */
export const LIBRARY_HIDDEN_KINDS = [KIND_CODE, KIND_OTHER];

/**
 * trigram 은 토큰 중간 일치를 잡지만 3자 미만 쿼리에 에러 없이 0건을 반환한다.
 * 한글 2글자 검색('이력', '통합')이 흔해서 그 구간은 LIKE 로 보낸다. 측정된 빈 구멍을
 * 메우는 것이고, 두 경로를 각각 테스트한다.
 */
export function planQuery(input) {
  const tokens = nfc(String(input ?? ''))
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (tokens.length === 0) return { mode: 'all', tokens: [] };
  const mode = tokens.some((t) => t.length < MIN_FTS_TOKEN_CHARS) ? 'like' : 'fts';
  return { mode, tokens };
}

function ftsExpression(tokens) {
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

const ARTIFACT_COLUMNS = `
  a.id, a.file_name, a.ext, a.size_bytes, a.mtime, a.state, a.favorite, a.missing_at,
  a.content_hash, a.abs_path, a.note, a.allow_scripts, a.final_hash, a.bundle_files, a.kind,
  d.body_state`;

// 출처는 여기서 조인하지 않는다. 한 아티팩트가 출처 여러 줄과 맞물리면 목록과 건수가
// 출처 수만큼 부푼다. 출처 조건은 EXISTS 로, 출처 표시는 LIMIT 이후 장식으로 붙인다.
const BASE_FROM = `
  FROM artifacts a
  LEFT JOIN search_docs d ON d.artifact_id = a.id`;

// 대표 출처의 순서. rowid 를 쓰지 않는다 — VACUUM 이 재번호해 대표가 이유 없이 바뀐다.
const ORIGIN_RANK = 'o.is_deliverable DESC, o.occurred_at DESC, o.collector, o.session_ref';

/** 어느 출처 하나만 맞아도 걸린다. */
function originMatches(column) {
  return `EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = a.id AND o.${column} = ?)`;
}

function filterClauses(store, filters = {}) {
  const where = [];
  const params = [];
  if (filters.provider) {
    where.push(originMatches('provider'));
    params.push(filters.provider);
  }
  if (filters.state) {
    where.push('a.state = ?');
    params.push(filters.state);
  }
  if (filters.ext) {
    where.push('a.ext = ?');
    params.push(filters.ext);
  }
  // 라이브러리 보기는 코드와 모르는 형식을 뺀다. 에이전트가 여러 저장소에서 쓴 파일은 새
  // 확장자가 끝없이 들어오고 그 대부분이 설정·빌드 파일이라(실측: 기타 20개 전부), 확장자를
  // 하나씩 코드로 옮기는 식으로는 계속 샌다. 모르는 형식은 기본으로 숨기고 종류로 꺼내 본다.
  // 종류를 직접 고르면 그 선택이 이긴다. IS NOT 은 NULL 안전하다 — 분류가 빈 행은 보여 준다.
  if (filters.view === 'library' && !filters.kind) {
    where.push(`a.kind IS NOT '${KIND_CODE}' AND a.kind IS NOT '${KIND_OTHER}'`);
  }
  if (filters.kind) {
    where.push('a.kind = ?');
    params.push(filters.kind);
  }
  if (filters.workspace) {
    where.push(originMatches('workspace'));
    params.push(filters.workspace);
  }
  if (filters.collector) {
    where.push(originMatches('collector'));
    params.push(filters.collector);
  }
  if (filters.favorite) where.push('a.favorite = 1');
  // 기간은 파일 mtime 이 아니라 에이전트가 손댄 시각이다. mtime 은 사람이 고쳐도 바뀌어서
  // "에이전트가 그 기간에 만든 것"을 흐린다. 그래프도 같은 시각을 센다.
  if (Number.isInteger(filters.since)) {
    where.push('EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = a.id AND o.occurred_at >= ?)');
    params.push(filters.since);
  }
  if (!filters.includeMissing) where.push('a.missing_at IS NULL');
  if (filters.tag) {
    where.push('a.id IN (SELECT at.artifact_id FROM artifact_tags at JOIN tags t ON t.id = at.tag_id WHERE t.name_key = ?)');
    params.push(nfc(filters.tag).toLowerCase());
  }
  return { where, params };
}

export function search(store, input, filters = {}, limit = DEFAULT_SEARCH_LIMIT) {
  const { where, params } = queryClauses(store, input, filters);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // 보일 행을 먼저 자르고 그 행에만 출처를 장식한다. 대표를 뷰로 계산하면 SQLite 가 출처
  // 테이블 전체를 매 질의 구체화해 공급자 필터가 0.11ms 에서 2.40ms 로 느려진다(측정).
  const sql = `
    WITH page AS (
      SELECT a.id ${BASE_FROM} ${whereSql}
      ORDER BY (a.state = 'final') DESC, a.mtime DESC LIMIT ?
    ),
    rep AS (
      SELECT * FROM (
        SELECT o.*, row_number() OVER (PARTITION BY o.artifact_id ORDER BY ${ORIGIN_RANK}) AS rank
        FROM artifact_origins o WHERE o.artifact_id IN (SELECT id FROM page)
      ) WHERE rank = 1
    )
    SELECT ${ARTIFACT_COLUMNS},
      rep.collector, rep.provider, rep.session_ref, rep.session_title, rep.session_dir, rep.workspace,
      (SELECT MAX(o.is_deliverable) FROM artifact_origins o WHERE o.artifact_id = a.id) AS is_deliverable,
      (SELECT COUNT(*) FROM artifact_origins o WHERE o.artifact_id = a.id) AS origin_count,
      -- 기간과 날짜 묶기가 같은 시각을 보게 한다. mtime 은 사람이 고쳐도 바뀐다.
      (SELECT MAX(o.occurred_at) FROM artifact_origins o WHERE o.artifact_id = a.id) AS touched_at,
      ${PROVIDERS_EXPR} AS providers,
      ${COLLECTORS_EXPR} AS collectors,
      ${DESCRIBE_COLUMNS}
    FROM page JOIN artifacts a ON a.id = page.id
    LEFT JOIN search_docs d ON d.artifact_id = a.id
    LEFT JOIN rep ON rep.artifact_id = a.id
    ORDER BY (a.state = 'final') DESC, a.mtime DESC`;
  return store.db.query(sql).all(...params, limit).map((row) => withDescription(withOriginLists(row)));
}

/** 목록은 상한을 두고 자르므로, 몇 건 중 몇 건을 보고 있는지 알려줘야 한다. */
export function searchCount(store, input, filters = {}) {
  const { where, params } = queryClauses(store, input, filters);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return store.db.query(`SELECT COUNT(*) AS n ${BASE_FROM} ${whereSql}`).get(...params).n;
}

/** 검색어 조건과 필터 조건을 합친다. search 와 searchCount 가 같은 집합을 보게 한다. */
function queryClauses(store, input, filters) {
  const plan = planQuery(input);
  const { where, params } = filterClauses(store, filters);
  if (plan.mode === 'fts') {
    where.unshift('a.id IN (SELECT rowid FROM artifact_fts WHERE artifact_fts MATCH ?)');
    params.unshift(ftsExpression(plan.tokens));
  } else if (plan.mode === 'like') {
    for (const token of plan.tokens) {
      where.unshift("(d.name LIKE ? ESCAPE '\\' OR d.path LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\' OR d.meta LIKE ? ESCAPE '\\')");
      const like = `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.unshift(like, like, like, like);
    }
  }
  return { where, params };
}

/**
 * 공급자 칩 목록. group_concat 은 순서를 보장하지 않아 칩이 스윕마다 흔들리고,
 * group_concat(DISTINCT x, sep) 는 bun:sqlite 에서 아예 실패한다. 정렬한 뒤에 모은다.
 */
const originList = (column) => `(SELECT group_concat(v) FROM (
    SELECT DISTINCT o.${column} AS v FROM artifact_origins o
    WHERE o.artifact_id = a.id AND o.${column} IS NOT NULL ORDER BY v))`;
const PROVIDERS_EXPR = originList('provider');
// 대표 출처의 수집기 하나로는 부족하다. 탐색기가 앱별로 묶을 때 두 앱이 수집한 파일(실측 62개)이
// 한쪽에서만 보이면 필터(EXISTS)와 다른 말을 한다.
const COLLECTORS_EXPR = originList('collector');

function withOriginLists(row) {
  const split = (value) => (value ? value.split(',') : []);
  return { ...row, providers: split(row.providers), collectors: split(row.collectors) };
}

// 루트 스레드 먼저, 그 안에서 이른 순. 서브에이전트 스레드의 제목은 그 스레드가 받은 지시라
// 파일이 왜 생겼는지를 말하지 못한다. 잡음을 거르는 건 describe 다 — 여기는 순서만 정한다.
const TASKS_EXPR = `(SELECT json_group_array(o.session_title ORDER BY
      (o.session_ref = COALESCE(o.conversation_ref, o.session_ref)) DESC, COALESCE(o.occurred_at, o.first_seen_at))
    FROM artifact_origins o WHERE o.artifact_id = a.id AND o.session_title IS NOT NULL)`;
// 대표 출처 하나가 아니라 전부. 파일을 담은 저장소를 고르는 건 describe 다.
const WORKSPACES_EXPR = `(SELECT json_group_array(DISTINCT o.workspace)
    FROM artifact_origins o WHERE o.artifact_id = a.id AND o.workspace IS NOT NULL)`;
const DESCRIBE_COLUMNS = `d.title AS doc_title, ${TASKS_EXPR} AS tasks_json, ${WORKSPACES_EXPR} AS workspaces_json`;

function withDescription({ doc_title: title, tasks_json: tasks, workspaces_json: workspaces, ...row }) {
  return {
    ...row,
    ...describe({
      title,
      fileName: row.file_name,
      tasks: JSON.parse(tasks ?? '[]'),
      workspaces: JSON.parse(workspaces ?? '[]'),
      absPath: row.abs_path,
    }),
  };
}

/** 상세 화면이 목록과 같은 규칙으로 부제·위치를 내게 한다. */
export function describeArtifact(store, id) {
  const row = store.db
    .query(`SELECT a.file_name, a.abs_path, ${DESCRIBE_COLUMNS}
            FROM artifacts a LEFT JOIN search_docs d ON d.artifact_id = a.id WHERE a.id = ?`)
    .get(id);
  if (!row) return null;
  const { subtitle, subtitle_source, location } = withDescription(row);
  return { subtitle, subtitle_source, location };
}

const TAG_JOIN = 'JOIN artifact_tags at ON at.artifact_id = a.id JOIN tags t ON t.id = at.tag_id';
const ORIGIN_FACET = { join: 'JOIN artifact_origins o ON o.artifact_id = a.id', distinct: true };

/**
 * 패싯 하나를 센다. 활성 필터를 자기 차원만 빼고 전부 적용한다 — 모든 필터를 모든 패싯에
 * 적용하면 `형식: md` 를 고르는 순간 형식 그룹이 한 줄로 접혀 다른 형식으로 갈아탈 수 없다.
 */
function facetGroup(store, filters, drop, valueExpr, { join = '', extra = null, distinct = false } = {}) {
  const { where, params } = filterClauses(store, { ...filters, ...drop });
  if (extra) where.push(extra);
  // 출처 차원을 조인하면 한 아티팩트가 출처 수만큼 세어진다. 사이드바 합이 목록 총계를 넘는다.
  const count = distinct ? 'COUNT(DISTINCT a.id)' : 'COUNT(*)';
  const sql = `SELECT ${valueExpr} AS value, ${count} AS n ${BASE_FROM} ${join}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY value ORDER BY n DESC`;
  return store.db.query(sql).all(...params);
}

export function facets(store, filters = {}) {
  return {
    // 사이드바가 '라이브러리 밖'을 표시하려면 서버와 같은 목록을 알아야 한다. 복사해 두면 어긋난다.
    libraryHidden: LIBRARY_HIDDEN_KINDS,
    // 라이브러리 제외 규칙 자체가 종류 필터다. 종류 차원을 빼면 그 규칙도 같이 빠져서,
    // 지금 범위 밖인 `코드` 도 전역 건수로 남는다 — 한 번의 클릭 거리에 둔다.
    // 이름표는 화면이 언어에 맞게 붙인다. 서버는 값만 보낸다 — 번역된 글자를 키로 쓰지 않게.
    kinds: facetGroup(store, filters, { kind: undefined, view: undefined }, "COALESCE(a.kind, 'unclassified')"),
    collectors: facetGroup(store, filters, { collector: undefined }, 'o.collector', ORIGIN_FACET),
    providers: facetGroup(store, filters, { provider: undefined }, 'o.provider', { ...ORIGIN_FACET, extra: 'o.provider IS NOT NULL' }),
    workspaces: facetGroup(store, filters, { workspace: undefined }, 'o.workspace', { ...ORIGIN_FACET, extra: 'o.workspace IS NOT NULL' }).slice(0, 12),
    states: facetGroup(store, filters, { state: undefined }, 'a.state'),
    exts: facetGroup(store, filters, { ext: undefined }, 'a.ext', { extra: "a.ext <> ''" }),
    tags: facetGroup(store, filters, { tag: undefined }, 't.name', { join: TAG_JOIN }),
  };
}

const SECONDS_PER_HOUR = 3_600;
const DAYS_PER_WEEK = 7;

const toUnix = (date) => Math.floor(date.getTime() / 1000);
const midnight = (date, offsetDays = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays);
const mondayOf = (date) => midnight(date, -((date.getDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK));

/** 기간의 시작 시각(지역 자정, 초). '전체'나 모르는 값은 null — 필터를 걸지 않는다. */
export function periodStart(period, now = new Date()) {
  const days = PERIOD_DAYS[period];
  return days ? toUnix(midnight(now, -(days - 1))) : null;
}

/**
 * 상단 현황 숫자. 각 숫자는 누르면 그 집합이 되는 필터와 같은 조건으로 센다 — 숫자와 누른
 * 뒤의 목록 건수가 다르면 숫자를 믿을 수 없다.
 */
export function overview(store, now = new Date()) {
  const library = { view: 'library' };
  return {
    library: searchCount(store, '', library),
    final: searchCount(store, '', { ...library, state: 'final' }),
    recent: searchCount(store, '', { ...library, since: periodStart(OVERVIEW_RECENT_PERIOD, now) }),
    recentPeriod: OVERVIEW_RECENT_PERIOD,
    recentDays: PERIOD_DAYS[OVERVIEW_RECENT_PERIOD],
    activeConversations: store.db
      // 세션이 없는 출처(가져오기, 저장소에서 찾은 문서)는 대화가 아니다.
      .query(`SELECT COUNT(DISTINCT o.collector || char(0) || ${CONVERSATION}) AS n
              FROM artifact_origins o WHERE o.occurred_at >= ? AND o.session_ref <> ''`)
      .get(toUnix(now) - OVERVIEW_ACTIVE_HOURS * SECONDS_PER_HOUR).n,
    activeHours: OVERVIEW_ACTIVE_HOURS,
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

// 그래프 한 칸의 크기. 오늘은 시간, 며칠은 하루, 전체는 한 주. 칸 이름은 그 칸의 시작이다.
const UNITS = {
  hour: {
    key: (date) => `${localDay(date)}T${pad2(date.getHours())}`,
    next: (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1),
  },
  day: { key: localDay, next: (date) => midnight(date, 1) },
  week: { key: (date) => localDay(mondayOf(date)), next: (date) => midnight(date, DAYS_PER_WEEK) },
};

/**
 * 칸마다 에이전트별로 몇 개를 썼나. 파일의 mtime 이 아니라 출처의 occurred_at 을 센다 —
 * 에이전트가 손댄 날이 그래프의 날이다. 탐색기와 같은 검색어·필터·기간을 받아 같은 집합을 센다.
 *
 * 칸은 SQL 이 아니라 여기서 자른다. SQLite 의 'localtime' 은 C 라이브러리의 시간대를 보고
 * JS 는 프로세스의 TZ 를 본다. 둘이 다르면(bun test 는 UTC 로 돈다) 자정 근처가 옆 칸으로 샌다.
 */
const ORIGIN_SCOPED_FILTERS = ['provider', 'collector', 'workspace'];

export function timeline(store, input, filters = {}, period = 'all', now = new Date()) {
  const { where, params } = queryClauses(store, input, filters);
  // 에이전트를 골랐으면 그 에이전트가 손댄 기록만 센다. 파일 집합만 좁히면 같은 파일을 만진
  // 다른 에이전트의 날까지 그래프에 섞여, "Claude Code 만 보기"가 Codex 막대를 그린다.
  for (const column of ORIGIN_SCOPED_FILTERS) {
    if (!filters[column]) continue;
    where.push(`t.${column} = ?`);
    params.push(filters[column]);
  }
  // 에이전트가 쓴 것만 센다. 세션이 없는 출처(가져오기, 저장소에서 찾은 문서)는 누가 썼는지 모른다.
  where.push("t.session_ref <> ''");
  const from = `${BASE_FROM} JOIN artifact_origins t ON t.artifact_id = a.id`;

  const days = PERIOD_DAYS[period];
  let unit;
  let start;
  if (days === 1) {
    unit = 'hour';
    start = midnight(now);
  } else if (days) {
    unit = 'day';
    start = midnight(now, -(days - 1));
  } else {
    // 전체는 첫 기록이 든 주부터. 너무 오래된 기록은 천장에서 자른다.
    unit = 'week';
    const first = store.db
      .query(`SELECT MIN(t.occurred_at) AS at ${from} WHERE ${[...where, 't.occurred_at IS NOT NULL'].join(' AND ')}`)
      .get(...params).at;
    const floor = midnight(mondayOf(now), -(MAX_TIMELINE_WEEKS - 1) * DAYS_PER_WEEK);
    start = first == null ? mondayOf(now) : mondayOf(new Date(Math.max(first * 1000, floor.getTime())));
  }

  const touches = store.db
    .query(`SELECT DISTINCT a.id, COALESCE(NULLIF(t.provider, ''), 'unknown') AS provider, t.occurred_at AS at
            ${from} WHERE ${[...where, 't.occurred_at >= ?'].join(' AND ')}`)
    .all(...params, toUnix(start));

  const { key, next } = UNITS[unit];
  const buckets = [];
  for (let cursor = start; cursor.getTime() <= now.getTime(); cursor = next(cursor)) {
    buckets.push({ key: key(cursor), start: toUnix(cursor), counts: {} });
  }
  // 한 파일을 같은 칸에서 여러 스레드가 건드려도 한 번이다.
  const index = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const seen = new Set();
  for (const touch of touches) {
    const bucket = index.get(key(new Date(touch.at * 1000)));
    if (!bucket) continue;
    const id = [bucket.key, touch.provider, touch.id].join('\u0000');
    if (seen.has(id)) continue;
    seen.add(id);
    bucket.counts[touch.provider] = (bucket.counts[touch.provider] ?? 0) + 1;
  }
  return {
    period: days ? period : 'all',
    unit,
    providers: [...new Set(touches.map((touch) => touch.provider))],
    buckets,
  };
}

/**
 * 방금 일어난 일. 탐색기와 같은 검색어·필터로 좁힌다 — 라이브러리에서는 코드 변경이 보이지 않는다.
 * 사라진 파일도 사라졌다는 사실은 보여야 하므로 원본 없음 행을 포함하고, 기간은 적용하지 않는다
 * (이 목록 자체가 최근이다).
 */
/**
 * 변경 기록 한 쪽. before 는 그보다 오래된 쪽(스크롤로 더 보기), after 는 그보다 새 쪽(실시간으로
 * 붙은 것)이다. 둘 다 사건 번호라 같은 초에 생긴 기록도 빠지거나 겹치지 않는다.
 */
export function recentChanges(store, input, filters = {}, limit = DEFAULT_CHANGE_LIMIT, { before = null, after = null } = {}) {
  const { where, params } = queryClauses(store, input, { ...filters, includeMissing: true, since: undefined });
  const scope = `SELECT a.id ${BASE_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const range = [];
  const rangeParams = [];
  if (Number.isInteger(before)) {
    range.push('e.id < ?');
    rangeParams.push(before);
  }
  if (Number.isInteger(after)) {
    range.push('e.id > ?');
    rangeParams.push(after);
  }
  const rows = store.db
    .query(`SELECT e.id, e.artifact_id, e.kind AS change, e.source, e.collector, e.provider, e.at,
                   a.file_name, a.kind, a.missing_at, a.abs_path, ${COLLECTORS_EXPR} AS collectors
            FROM artifact_events e JOIN artifacts a ON a.id = e.artifact_id
            WHERE e.artifact_id IN (${scope}) ${range.map((clause) => `AND ${clause}`).join(' ')}
            ORDER BY e.id DESC LIMIT ?`)
    .all(...params, ...rangeParams, limit + 1);
  const more = rows.length > limit;
  const changes = rows.slice(0, limit)
    .map((row) => ({ ...row, collectors: row.collectors ? row.collectors.split(',') : [], ...describeArtifact(store, row.artifact_id) }));

  // 라이브러리가 숨긴 종류의 변경도 같은 구간에 몇 개 있었는지 알린다. 조용히 빼면 "방금 고친 파일이
  // 왜 안 보이나"가 된다(실제로 그랬다). 구간은 이 쪽이 덮는 사건 번호다 — 더 오래된 게 남았으면
  // 이 쪽의 가장 오래된 줄까지, 아니면 끝까지. 쪽마다 겹치지 않아 화면이 더해 쓸 수 있다.
  let hidden = {};
  if (filters.view === 'library' && !filters.kind) {
    const lowest = more ? changes.at(-1).id : Number.isInteger(after) ? after + 1 : 0;
    const kinds = LIBRARY_HIDDEN_KINDS.map(() => '?').join(', ');
    hidden = Object.fromEntries(store.db
      .query(`SELECT x.kind, COUNT(*) AS n FROM artifact_events e JOIN artifacts x ON x.id = e.artifact_id
              WHERE e.id >= ? AND e.id < ? AND x.kind IN (${kinds}) GROUP BY x.kind`)
      .all(lowest, before ?? Number.MAX_SAFE_INTEGER, ...LIBRARY_HIDDEN_KINDS)
      .map((row) => [row.kind, row.n]));
  }
  return { changes, hidden, more };
}

const ACTIVITY_SESSION_LIMIT = 40;
const ACTIVITY_FILES_PER_SESSION = 12;

/**
 * 활동 보기는 파일 목록이 아니라 작업 타임라인이다. 단위는 대화다 — Codex 는 대화 하나가
 * 서브에이전트 스레드를 수십 개 띄우고 스레드마다 로그가 따로 남는다. 스레드 단위로 세우면
 * 사용자가 한 번 말한 작업이 카드 수십 장으로 쪼개진다(실측: 롤아웃 42개가 대화 4개였다).
 */
const CONVERSATION = 'COALESCE(o.conversation_ref, o.session_ref)';

export function activity(store, { limit = ACTIVITY_SESSION_LIMIT, collector, workspace, since } = {}) {
  const where = ["o.session_ref <> ''", 'a.missing_at IS NULL'];
  const params = [];
  if (Number.isInteger(since)) {
    where.push('o.occurred_at >= ?');
    params.push(since);
  }
  if (collector) {
    where.push('o.collector = ?');
    params.push(collector);
  }
  if (workspace) {
    where.push('o.workspace = ?');
    params.push(workspace);
  }

  const sessions = store.db
    .query(
      `SELECT o.collector, ${CONVERSATION} AS session_ref,
              MAX(o.provider)    AS provider,
              -- 제목은 루트 스레드의 첫 발화다. 서브에이전트 스레드의 제목은 그 스레드가
              -- 받은 지시라 대화 전체를 대표하지 못한다. 루트가 파일을 안 썼으면 아무 스레드.
              COALESCE(MAX(CASE WHEN o.session_ref = ${CONVERSATION} THEN o.session_title END),
                       MAX(o.session_title)) AS session_title,
              MAX(o.workspace)   AS workspace,
              MAX(o.prompt)      AS prompt,
              MAX(o.session_dir) AS session_dir,
              COUNT(DISTINCT o.artifact_id) AS file_count,
              COUNT(DISTINCT CASE WHEN o.session_ref <> ${CONVERSATION} THEN o.session_ref END) AS subagent_count,
              -- 대화 자신의 시각으로 세운다. 파일 수정 시각을 쓰면 다른 대화가 오늘 고친
              -- 파일 때문에 몇 주 전 대화가 '방금'으로 올라온다.
              MAX(COALESCE(o.occurred_at, a.mtime)) AS at,
              COUNT(DISTINCT CASE WHEN a.state = 'final' THEN a.id END) AS final_count
       FROM artifact_origins o JOIN artifacts a ON a.id = o.artifact_id
       WHERE ${where.join(' AND ')}
       GROUP BY o.collector, ${CONVERSATION}
       ORDER BY at DESC LIMIT ?`,
    )
    .all(...params, limit);

  // 한 파일을 여러 스레드가 건드리면 출처가 여러 줄이다. 파일은 한 번만 보인다.
  const filesOf = store.db.query(
    `SELECT a.id, a.file_name, a.ext, MAX(a.mtime) AS mtime, a.state, a.bundle_files, a.size_bytes
     FROM artifacts a JOIN artifact_origins o ON o.artifact_id = a.id
     WHERE o.collector = ? AND ${CONVERSATION} = ? AND a.missing_at IS NULL
     GROUP BY a.id ORDER BY MAX(COALESCE(o.occurred_at, a.mtime)) DESC LIMIT ?`,
  );

  return sessions.map((session) => ({
    ...session,
    files: filesOf.all(session.collector, session.session_ref, ACTIVITY_FILES_PER_SESSION),
  }));
}
