const $ = (id) => document.getElementById(id);
// 문구는 i18n.js 사전에서 온다. 언어는 바뀔 수 있으므로 호출할 때마다 현재 값을 읽는다.
const { t, num } = globalThis.i18n;
const locale = () => globalThis.i18n.locale();
/** 사전에 없는 값(새 수집기, 새 제외 이유)은 키 대신 원래 값을 보인다. */
const tOr = (key, fallback) => {
  const text = t(key);
  return text === key ? fallback : text;
};

// 서버가 MAX_SEARCH_LIMIT 에서 자른다. 트리는 저장소별로 묶어야 해서 라이브러리 전체가 필요하다.
const TREE_LIMIT = 5000;
// 한 파일을 최대 17세션이 건드렸다. 전부 펼치면 정보 패널을 덮는다.
const ORIGIN_PREVIEW_COUNT = 8;
const HOME_LIST_COUNT = 6;
// 변경 목록은 한 번에 이만큼 받고, 개요에는 앞의 몇 개만 둔다.
const CHANGE_PAGE_SIZE = 30;
// 이 시간 안에 생기거나 바뀐 파일에는 트리에서 표시를 단다. 그 뒤로는 평범한 줄로 돌아간다.
const FRESH_WINDOW_S = 10 * 60;
// 미리보기에서 칠하는 일치의 상한. 2MB 로그에서 흔한 낱말을 찾으면 수만 곳이 맞아 화면이 멈춘다.
const MAX_PREVIEW_MARKS = 500;
// 격리된 문서 안에서 첫 일치가 받는 id. 부모는 이 이름으로만 그 자리를 가리킬 수 있다.
const PREVIEW_HIT_ID = 'aoc-search-hit';
const EXPLORER_WIDTH = { min: 240, max: 560, step: 16, initial: 340 };
const LIVE_COALESCE_MS = 400;
const SEARCH_DEBOUNCE_MS = 120;
const ACTIVITY_FILTERS = new Set(['collector', 'workspace']);
// 기간 값은 서버의 PERIOD_DAYS 키와 같다. 시작 시각은 서버가 정한다 — 목록·현황·그래프가 같은 자정을 쓴다.
const PERIODS = ['all', 'today', '7d', '30d', '90d'];
// 탐색기 트리의 첫 단. 저장소가 기본이고, 나머지는 첫 단만 바꾸고 둘째 단은 위치(저장소·작업)다.
const GROUPINGS = ['repo', 'provider', 'collector', 'date', 'kind'];

const state = {
  q: '',
  filters: {},
  mode: 'library',
  view: 'home',
  selected: null,
  rows: [],
  total: 0,
  tree: [],
  parents: new Map(),
  visible: [],
  signature: '',
  facets: null,
  overview: null,
  rawMode: false,
  showAllOrigins: false,
  searchOpen: {},
  detail: null,
  changes: [],
  changesMore: false,
  changesLoading: false,
  hiddenChanges: {},
  period: 'all',
};
// 선택할 때 트리를 다시 그리면 스크롤과 포커스가 튄다. 노드를 들고 있다가 속성만 바꾼다.
// 에이전트·앱별로 묶으면 두 에이전트가 만든 파일은 두 묶음에 모두 있으므로 id 하나에 노드가 여럿이다.
const rowNodes = new Map();
const addRowNode = (id, node) => rowNodes.set(id, [...(rowNodes.get(id) ?? []), node]);
const scrollToRow = (id) => rowNodes.get(id)?.[0]?.scrollIntoView({ block: 'nearest' });

// 보던 자리(펼친 폴더, 패널 폭)는 이 브라우저의 편의일 뿐이다. 저장이 막힌 환경에서도 화면은 돌아야 한다.
const prefs = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(`aoc.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(`aoc.${key}`, JSON.stringify(value));
    } catch {
      // 사생활 보호 창 등. 다음 방문에 기본값으로 돌아갈 뿐이다.
    }
  },
};
const openState = prefs.read('tree.open', {});
const facetOpen = prefs.read('facets.open', { kind: true });
let inspectorOpen = prefs.read('inspector.open', true);
let groupBy = GROUPINGS.includes(prefs.read('tree.groupBy', 'repo')) ? prefs.read('tree.groupBy', 'repo') : 'repo';

const api = async (path, options) => {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
};
const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const fmtBytes = (n) => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
};
const fmtDate = (unix) => (unix ? new Date(unix * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function relativeWhen(unix) {
  const age = Date.now() / 1000 - unix;
  if (age < MINUTE) return t('time.justNow');
  // 언어마다 "3분 전", "3 minutes ago", 하루 전은 "어제", "yesterday" 가 된다.
  const relative = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (age < HOUR) return relative.format(-Math.floor(age / MINUTE), 'minute');
  if (age < DAY) return relative.format(-Math.floor(age / HOUR), 'hour');
  return age < WEEK ? relative.format(-Math.floor(age / DAY), 'day') : fmtDate(unix);
}

/** 트리 한 줄에 들어가는 짧은 시각. 일주일이 넘으면 날짜만. */
function shortWhen(unix) {
  const age = Date.now() / 1000 - unix;
  if (age < HOUR) return t('short.minutes', { n: Math.max(1, Math.floor(age / MINUTE)) });
  if (age < DAY) return t('short.hours', { n: Math.floor(age / HOUR) });
  if (age < WEEK) return t('short.days', { n: Math.floor(age / DAY) });
  return new Date(unix * 1000).toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' });
}

// 목록의 문자열은 전부 에이전트가 쓴 파일과 로그에서 온다. 텍스트 노드로만 넣는다 —
// innerHTML 을 쓰면 문서 제목 하나가 화면에서 스크립트가 된다.
function el(tag, props = {}, ...children) {
  const { attrs, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value != null && value !== false) node.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const keep = (nodes) => nodes.filter((n) => n != null && n !== false);

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  chevron: 'M6 4l4 4-4 4',
  repo: 'M4.5 2.5h8v11h-8A1.5 1.5 0 0 1 3 12V4a1.5 1.5 0 0 1 1.5-1.5zM3 12a1.5 1.5 0 0 1 1.5-1.5h8',
  folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z',
  session: 'M3 3.5h10v7H7.5L4.5 13v-2.5H3z',
  doc: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4',
  pdf: 'M4 2h5l3 3v9H4zM9 2v3h3M6 9.5h4',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3',
  web: 'M2.5 3.5h11v9h-11zM2.5 6h11M6.5 8l-1.5 1.5L6.5 11M9.5 8l1.5 1.5L9.5 11',
  sheet: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9',
  bundle: 'M2.5 5L8 2.5 13.5 5v6.5L8 14l-5.5-2.5zM2.5 5L8 7.5 13.5 5M8 7.5V14',
  collapse: 'M5 3l3 3 3-3M5 13l3-3 3 3',
  app: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
  date: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3',
  panel: 'M2.5 3h11v10h-11zM10 3v10',
  sun: 'M8 5.25a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 1 0 0-5.5zM8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05',
  moon: 'M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z',
  auto: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM8 2.5v11M8 5l3.2-1.6M8 8h5.4M8 11l3.2 1.6',
};
const KIND_ICON = { text: 'doc', code: 'doc', memo: 'doc', office: 'doc', other: 'doc', markup: 'web', image: 'image', sheet: 'sheet', pdf: 'pdf', bundle: 'bundle' };

function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.doc);
  svg.append(path);
  return svg;
}

const PROVIDER_LABEL = { 'openai-codex': 'Codex', 'claude-code': 'Claude Code', 'ai-mesh': 'ai-mesh', aside: 'Aside' };
const COLLECTOR_NAME = { codex: 'Codex', 'claude-code': 'Claude Code', aside: 'Aside' };
const collectorLabel = (collector) => COLLECTOR_NAME[collector] ?? tOr(`collector.${collector}`, t('collector.import'));
const stateLabel = (value) => tOr(`state.${value}`, value);
const kindLabel = (value) => tOr(`kind.${value ?? 'unclassified'}`, value);
// 활동 카드는 수집기 이름을 단다. Aside 가 실어 온 Claude 세션에 Claude 색을 칠하면 수집기를 잘못 말한다.
const PROVIDER_OF_COLLECTOR = { codex: 'openai-codex', 'claude-code': 'claude-code' };
const subtitleSource = (source) => tOr(`subtitle.${source}`, '');

/** 출처에서 파생된 분류. 누르면 그 에이전트로 좁힌다 — 행 선택과 겹치지 않게 전파를 끊는다. */
function providerChips(providers) {
  return (providers ?? []).map((provider) =>
    el('button', {
      type: 'button',
      className: 'chip',
      title: t('chip.only', { name: PROVIDER_LABEL[provider] ?? provider }),
      attrs: { 'data-provider': provider },
      onclick: (event) => {
        event.stopPropagation();
        toggleFilter('provider', provider);
      },
    }, PROVIDER_LABEL[provider] ?? provider));
}

/** 최근에 생기거나 바뀐 파일의 표시. 사라짐은 트리에 행이 없으니 뺀다. */
function freshKind(id) {
  const since = Date.now() / 1000 - FRESH_WINDOW_S;
  const latest = state.changes.find((change) => change.artifact_id === id);
  return latest && latest.at >= since && latest.change !== 'missing' ? latest.change : null;
}

function badges(row, { compact = false } = {}) {
  const fresh = freshKind(row.id);
  return keep([
    fresh && el('span', { className: `badge fresh fresh-${fresh}` }, t(`fresh.${fresh}`)),
    // 여러 에이전트가 손댄 파일은 충돌이 아니라 중요도의 신호다.
    // SQLite 불리언은 0/1 이다. `0 && …` 은 0 을 남겨 화면에 "0" 이 찍힌다.
    !compact && (row.providers?.length ?? 0) > 1 && el('span', { className: 'badge multi' }, t('badge.agents', { n: row.providers.length })),
    !compact && Boolean(row.bundle_files) && el('span', { className: 'badge' }, t('badge.bundle', { n: row.bundle_files })),
    Boolean(row.missing_at) && el('span', { className: 'badge missing' }, t('badge.missing')),
    row.state === 'final' && el('span', { className: 'badge final' }, t('badge.final')),
    Boolean(row.favorite) && el('span', { className: 'badge fav', title: t('badge.favorite') }, '★'),
  ]);
}

/** 저장소 안이면 저장소 이름 + 저장소 안 경로, 밖이면 실제 경로, 작업공간이 없으면 수집기. */
// git worktree 의 파일은 본 저장소 아래에 선다. 어느 체크아웃의 것인지는 이 이름표가 말한다.
const worktreeLabel = (name) => `⑂ ${name}`;

function locationNodes(row) {
  const where = row.location;
  if (!where) return [el('span', {}, collectorLabel(row.collector))];
  return keep([
    where.repo && el('span', { className: 'where-repo' }, where.repo),
    where.worktree && el('span', { className: 'where-worktree', title: t('where.worktree', { name: where.worktree }) }, worktreeLabel(where.worktree)),
    el('span', { className: 'where-dir', title: row.abs_path }, where.dir),
  ]);
}

// ── 검색 · 필터 ─────────────────────────────────────────────────────────

/** 목록과 사이드바가 같은 범위를 보도록 한 곳에서 만든다. */
function searchParams(extra = {}) {
  const params = new URLSearchParams({ q: state.q, view: 'library', ...extra });
  for (const [key, value] of Object.entries(state.filters)) params.set(key, value === true ? '1' : value);
  if (state.period !== 'all') params.set('period', state.period);
  return params;
}

/** 활동 보기가 듣는 것만. 목록이 무시하는 필터로 사이드바를 좁히면 없는 것을 광고한다. */
function activityParams() {
  const params = new URLSearchParams();
  for (const key of ACTIVITY_FILTERS) if (state.filters[key]) params.set(key, state.filters[key]);
  if (state.period !== 'all') params.set('period', state.period);
  return params;
}

const isSearching = () => state.q.trim() !== '' || Object.keys(state.filters).length > 0 || state.period !== 'all';
// 관련도는 검색어가 있을 때만 있다. 필터와 기간은 집합을 좁힐 뿐이라 트리를 그대로 둔다.
const hasQuery = () => state.q.trim() !== '';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 검색어를 찾는 정규식. 긴 낱말을 앞에 둔다 — 짧은 낱말이 긴 낱말의 앞부분을 먼저 가져가지 않게. */
function queryPattern() {
  const tokens = state.q.normalize('NFC').split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  return tokens.length ? new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'giu') : null;
}

/**
 * 검색어가 맞은 곳을 <mark> 로 감싼 노드들. 글자는 텍스트 노드로만 넣는다 — 파일명과 발췌는
 * 에이전트가 쓴 내용이다. 파일명은 NFD 일 수 있어서 검색어와 같은 NFC 로 맞춘 뒤 찾는다.
 * limit 을 넘긴 뒤의 글자는 한 덩어리로 둔다.
 */
function highlighted(text, limit = Infinity) {
  const pattern = queryPattern();
  if (!pattern || limit <= 0) return [text];
  const parts = text.normalize('NFC').split(pattern);
  const nodes = [];
  let marks = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (marks >= limit) {
      nodes.push(parts.slice(i).join(''));
      break;
    }
    if (parts[i] === '') continue;
    if (i % 2 === 1) marks += 1;
    nodes.push(i % 2 === 1 ? el('mark', {}, parts[i]) : parts[i]);
  }
  return nodes;
}

function renderPeriod() {
  $('period').replaceChildren(...PERIODS.map((value) =>
    el('button', {
      type: 'button',
      attrs: { role: 'radio', 'aria-checked': String(state.period === value) },
      onclick: () => setPeriod(value),
    }, t(`period.${value}`))));
}

function setPeriod(period) {
  state.period = period;
  state.searchOpen = {};
  renderPeriod();
  void refresh();
}

/**
 * 활동 보기는 고른 파일이 없으면 화면 전체를 쓴다. 340px 칸에서는 세션마다 파일 칩 열댓 개가 여러 줄로
 * 접혔고, 오른쪽에는 활동과 무관한 직전 문서가 남아 있었다. 같은 목록이 폭만 달라진다 — 파일을 고르면
 * 타임라인은 왼쪽 칸으로 물러나고 오른쪽에 내용이 선다.
 */
function updateWide() {
  $('layout').toggleAttribute('data-wide', state.mode === 'activity' && state.view === 'home');
}

function setModeState(mode) {
  state.mode = mode;
  $('mode-library').setAttribute('aria-selected', String(mode === 'library'));
  $('mode-activity').setAttribute('aria-selected', String(mode === 'activity'));
  $('q').disabled = mode === 'activity';
  $('q').placeholder = t(mode === 'activity' ? 'search.disabled' : 'search.placeholder');
  updateWide();
}

function setMode(mode) {
  setModeState(mode);
  // 활동으로 들어갈 때는 보던 문서를 내려놓는다. 남겨 두면 타임라인 옆에 상관없는 문서가 서 있다.
  if (mode === 'activity') goHome();
  void refresh();
}

function toggleFilter(key, value) {
  const on = state.filters[key] === value;
  if (on) delete state.filters[key];
  else state.filters[key] = value;
  // 활동 보기는 수집기·작업공간만 본다. 다른 필터를 누르면 그 필터가 듣는 화면으로 간다.
  if (!on && state.mode === 'activity' && !ACTIVITY_FILTERS.has(key)) setModeState('library');
  state.searchOpen = {};
  void refresh();
}

function resetLibrary() {
  state.filters = {};
  state.period = 'all';
  renderPeriod();
  state.q = '';
  $('q').value = '';
  state.searchOpen = {};
  setModeState('library');
  void refresh();
}

/** 작업공간 이름표. 같은 저장소를 두 군데에 받아 둔 경우처럼 이름이 겹치면 부모 폴더까지 보인다. */
function workspaceLabel(path) {
  const name = path.split('/').pop();
  const clash = (state.facets?.workspaces ?? []).some((w) => w.value !== path && w.value.split('/').pop() === name);
  return clash ? path.split('/').slice(-2).join('/') : name;
}

function filterDisplay(key, value) {
  switch (key) {
    case 'favorite': return t('filter.favorite');
    case 'kind': return kindLabel(value);
    case 'provider': return `${t('filter.provider')}: ${PROVIDER_LABEL[value] ?? value}`;
    case 'collector': return `${t('filter.collector')}: ${collectorLabel(value)}`;
    case 'state': return stateLabel(value);
    case 'workspace': return `${t('filter.workspace')}: ${workspaceLabel(String(value))}`;
    default: return `${tOr(`filter.${key}`, key)}: ${value}`;
  }
}

function renderActiveFilters() {
  const tokens = Object.entries(state.filters).map(([key, value]) =>
    el('button', {
      type: 'button',
      className: 'token',
      title: t('filter.clearOne'),
      // summary 안의 버튼이라 기본 동작이 패널을 여닫는다. 토큰은 필터만 지운다.
      onclick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter(key, value);
      },
    }, filterDisplay(key, value), el('span', { className: 'token-x', attrs: { 'aria-hidden': 'true' } }, '×')));
  $('active-filters').replaceChildren(...tokens);
}

async function loadFacets() {
  // 활동 보기는 collector·workspace 만 본다. 목록이 무시하는 필터로 사이드바를 좁히면
  // 사이드바가 목록에 없는 것을 광고한다.
  const params = state.mode === 'activity' ? activityParams() : searchParams();
  state.facets = await api(`/api/facets?${params}`);
  return state.facets;
}

const addCounts = (base, extra = {}) =>
  Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(extra)])].map((key) => [key, (base[key] ?? 0) + (extra[key] ?? 0)]));

/**
 * 변경 기록은 쪽 단위로 쌓는다. 실시간 갱신은 가장 새 줄 뒤(after)만 받아 위에 붙인다 — 첫 쪽을
 * 다시 받으면 스크롤로 불러 둔 이전 기록이 사라진다. 한 쪽보다 많이 밀렸으면 처음부터 다시 받는다.
 */
async function loadChanges({ live = false } = {}) {
  const newest = state.changes[0]?.id;
  try {
    if (live && newest !== undefined) {
      const data = await api(`/api/changes?${searchParams({ limit: CHANGE_PAGE_SIZE, after: newest })}`);
      if (!data.more) {
        state.changes = [...data.changes, ...state.changes];
        state.hiddenChanges = addCounts(state.hiddenChanges, data.hidden);
        return;
      }
    }
    const data = await api(`/api/changes?${searchParams({ limit: CHANGE_PAGE_SIZE })}`);
    state.changes = data.changes;
    state.changesMore = data.more;
    state.hiddenChanges = data.hidden ?? {};
  } catch {
    // 변경 목록은 보조 정보다. 못 받아도 트리와 개요는 그대로 그린다.
    state.changes = [];
    state.changesMore = false;
    state.hiddenChanges = {};
  }
}

/** 스크롤이 목록 끝에 닿으면 한 쪽 더. 그사이 필터가 바뀌어 목록이 새로 찼으면 받은 쪽을 버린다. */
async function loadOlderChanges() {
  const oldest = state.changes.at(-1)?.id;
  if (state.changesLoading || !state.changesMore || oldest === undefined) return;
  state.changesLoading = true;
  let data;
  try {
    data = await api(`/api/changes?${searchParams({ limit: CHANGE_PAGE_SIZE, before: oldest })}`);
  } catch {
    // 끝 표시가 계속 보이면 관찰자가 곧바로 다시 부른다. 실패는 그대로 두고 다음 스크롤에 맡긴다.
    return;
  } finally {
    state.changesLoading = false;
  }
  if (state.changes.at(-1)?.id !== oldest) return;
  state.changes = [...state.changes, ...data.changes];
  state.changesMore = data.more;
  state.hiddenChanges = addCounts(state.hiddenChanges, data.hidden);
  replaceChangesPanel();
}

async function refreshFacets() {
  renderFilters(await loadFacets());
}

function renderFilters(data) {
  const hidden = new Set(data.libraryHidden ?? []);
  const shorten = (path) => path.split('/').slice(-2).join('/');
  const groups = state.mode === 'activity'
    ? [
        ['collector', t('filter.collector'), data.collectors.map((c) => ({ ...c, display: collectorLabel(c.value) }))],
        ['workspace', t('filter.workspace'), (data.workspaces ?? []).map((w) => ({ ...w, display: shorten(w.value) }))],
      ]
    : [
        ['kind', t('filter.kind'), data.kinds.map((k) => ({ ...k, display: kindLabel(k.value) }))],
        ['provider', t('filter.provider'), data.providers.map((p) => ({ ...p, display: PROVIDER_LABEL[p.value] ?? p.value }))],
        ['state', t('filter.state'), data.states.map((s) => ({ ...s, display: stateLabel(s.value) }))],
        ['ext', t('filter.ext'), data.exts],
        ['collector', t('filter.collector'), data.collectors.map((c) => ({ ...c, display: collectorLabel(c.value) }))],
        ['tag', t('filter.tag'), data.tags],
      ];

  const favorite = state.mode === 'library' && el('button', {
    type: 'button',
    className: 'facet',
    attrs: { 'aria-pressed': String(Boolean(state.filters.favorite)) },
    onclick: () => toggleFilter('favorite', true),
  }, el('span', { className: 'facet-name' }, t('facet.favoritesOnly')));

  const sections = groups.filter(([, , items]) => items?.length).map(([key, label, items]) => {
    const active = state.filters[key];
    const group = el('details', { className: 'facet-group', open: Boolean(facetOpen[key] || active) },
      el('summary', {}, icon('chevron', 'chevron'), el('span', {}, label),
        active !== undefined && el('span', { className: 'facet-active' }, filterDisplay(key, active).replace(/^[^:]+: /, ''))),
      ...items.filter((item) => item.value).map((item) => {
        // 라이브러리에서 코드는 목록에 없다. 같은 모양으로 두면 고친 걸로 읽히지 않는다.
        const outOfScope = key === 'kind' && hidden.has(item.value) && active !== item.value;
        return el('button', {
          type: 'button',
          className: `facet${outOfScope ? ' out-of-scope' : ''}`,
          title: outOfScope ? t('facet.outOfScopeTitle') : String(item.value),
          attrs: { 'aria-pressed': String(active === item.value) },
          onclick: () => toggleFilter(key, item.value),
        },
          el('span', { className: 'facet-name' }, item.display ?? item.value),
          outOfScope && el('span', { className: 'facet-note' }, t('facet.outOfScope')),
          el('span', { className: 'n' }, item.n.toLocaleString(locale())));
      }));
    group.addEventListener('toggle', () => {
      facetOpen[key] = group.open;
      prefs.write('facets.open', facetOpen);
    });
    return group;
  });

  $('facets').replaceChildren(...keep([favorite, ...sections]));
  renderActiveFilters();

  const outside = state.mode === 'library' && !state.filters.kind
    ? data.kinds.filter((k) => hidden.has(k.value)).reduce((sum, k) => sum + k.n, 0)
    : 0;
  $('out-of-scope').replaceChildren(outside > 0
    ? el('button', {
        type: 'button',
        className: 'link quiet-link',
        title: t('facet.outsideTitle'),
        onclick: () => {
          $('filters').open = true;
          facetOpen.kind = true;
          renderFilters(state.facets);
        },
      }, t('facet.outsideCount', { n: outside }))
    : '');
}

// ── 현황 ───────────────────────────────────────────────────────────────

async function refreshOverview() {
  state.overview = await api('/api/overview');
  renderStats();
}

function renderStats() {
  const numbers = state.overview;
  if (!numbers) return;
  const stat = (n, label, { pressed, onclick, title }) =>
    el('button', { type: 'button', className: 'stat', title, onclick, attrs: { 'aria-pressed': String(pressed) } },
      el('span', { className: 'stat-n' }, n.toLocaleString(locale())),
      el('span', { className: 'stat-label' }, label));
  $('stats').replaceChildren(
    stat(numbers.library, t('stat.library'), {
      pressed: state.mode === 'library' && !isSearching(),
      onclick: resetLibrary,
      title: t('stat.libraryTitle'),
    }),
    stat(numbers.final, t('stat.final'), {
      pressed: state.mode === 'library' && state.filters.state === 'final',
      onclick: () => toggleFilter('state', 'final'),
      title: t('stat.finalTitle'),
    }),
    stat(numbers.recent, t('stat.recent', { n: numbers.recentDays }), {
      pressed: state.period === numbers.recentPeriod,
      onclick: () => setPeriod(state.period === numbers.recentPeriod ? 'all' : numbers.recentPeriod),
      title: t('stat.recentTitle', { n: numbers.recentDays }),
    }),
    stat(numbers.activeConversations, t('stat.active', { n: numbers.activeHours }), {
      pressed: state.mode === 'activity',
      onclick: () => setMode(state.mode === 'activity' ? 'library' : 'activity'),
      title: t('stat.activeTitle', { n: numbers.activeHours }),
    }),
  );
}

// ── 탐색기 트리 ─────────────────────────────────────────────────────────
// 저장소 → 폴더 → 파일. 위치 정보(describe.mjs)를 그대로 경로로 쓴다. 작업공간이 없는
// Aside 산출물은 수집기 아래 작업 제목으로 묶는다 — 거기서는 작업이 곧 폴더다.

function treePlacement(row) {
  const where = row.location;
  if (where?.repo) {
    const folders = where.dir === '/' ? [] : where.dir.replace(/\/$/, '').split('/');
    return {
      group: { key: `repo:${where.repo}`, label: where.repo, icon: 'repo' },
      // worktree 는 저장소 아래 한 단으로 둔다. 본 저장소와 worktree 에 같은 README 가 있어도 구분된다.
      folders: where.worktree ? [worktreeLabel(where.worktree), ...folders] : folders,
      folderIcon: 'folder',
      flatten: true,
    };
  }
  if (where) {
    return {
      group: { key: 'elsewhere', label: t('tree.elsewhere'), icon: 'folder' },
      folders: [where.dir.replace(/\/$/, '')],
      folderIcon: 'folder',
      mono: true,
    };
  }
  return {
    group: { key: `collector:${row.collector}`, label: collectorLabel(row.collector), icon: 'session' },
    folders: [row.session_title ?? t('tree.untitledTask')],
    folderIcon: 'session',
  };
}

const folderNode = (key, label, extra = {}) => ({ key, label, folders: new Map(), files: [], count: 0, latest: 0, ...extra });

function buildTree(rows) {
  const roots = groupBy === 'repo' ? buildRepoTree(rows) : buildPivotTree(rows);
  state.parents = new Map();
  for (const root of roots) recordParents(root, []);
  return roots;
}

function buildRepoTree(rows) {
  const groups = new Map();
  for (const row of rows) {
    const place = treePlacement(row);
    let node = groups.get(place.group.key);
    if (!node) {
      node = folderNode(place.group.key, place.group.label, { icon: place.group.icon, root: true });
      groups.set(place.group.key, node);
    }
    for (const name of place.folders) {
      const key = `${node.key}/${name}`;
      if (!node.folders.has(key)) {
        node.folders.set(key, folderNode(key, name, { icon: place.folderIcon, mono: place.mono, flatten: place.flatten }));
      }
      node = node.folders.get(key);
    }
    node.files.push(row);
  }
  // 저장소 밖 경로는 대개 에이전트 설정·임시 파일이다. 최근이어도 저장소와 Aside 뒤에 둔다.
  const roots = [...groups.values()].map(finish);
  return roots.sort((a, b) => (a.key === 'elsewhere') - (b.key === 'elsewhere') || byLatest(a, b));
}

/** 로컬 자정 기준. 서버 시각이 아니라 보는 사람의 하루로 나눈다. */
function dateBucket(unix) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  if (unix >= today) return { key: 'today', label: t('date.today') };
  if (unix >= today - DAY) return { key: 'yesterday', label: t('date.yesterday') };
  if (unix >= today - 6 * DAY) return { key: 'week', label: t('date.week') };
  if (unix >= today - 29 * DAY) return { key: 'month', label: t('date.month') };
  const date = new Date(unix * 1000);
  return { key: `${date.getFullYear()}-${date.getMonth() + 1}`, label: date.toLocaleDateString(locale(), { year: 'numeric', month: 'long' }) };
}

/**
 * 첫 단 묶음. 여러 에이전트·앱이 손댄 파일은 각 묶음에 모두 둔다 — 필터(EXISTS)가 그렇게
 * 답하므로 묶음도 같은 말을 해야 한다. 그래서 묶음 개수의 합은 전체보다 클 수 있다.
 */
function firstLevel(row) {
  switch (groupBy) {
    case 'provider':
      return row.providers.length
        ? row.providers.map((p) => ({ key: p, label: PROVIDER_LABEL[p] ?? p, dot: p }))
        : [{ key: 'unknown', label: t('agent.unknown'), icon: 'session' }];
    case 'collector':
      return (row.collectors?.length ? row.collectors : [row.collector]).map((c) =>
        ({ key: c, label: collectorLabel(c), dot: PROVIDER_OF_COLLECTOR[c] ?? c }));
    case 'date':
      return [{ ...dateBucket(touchedAt(row)), icon: 'date' }];
    default:
      return [{ key: row.kind ?? 'unknown', label: kindLabel(row.kind), icon: KIND_ICON[row.kind] ?? 'doc' }];
  }
}

/** 둘째 단은 어디서: 저장소, 저장소 밖, 작업공간이 없으면 작업 제목. */
function placeOf(row) {
  const where = row.location;
  if (where?.repo) return { key: `repo:${where.repo}`, label: where.repo, icon: 'repo' };
  if (where) return { key: 'elsewhere', label: t('tree.elsewhere'), icon: 'folder' };
  return { key: `task:${row.collector}:${row.session_title ?? ''}`, label: row.session_title ?? t('tree.untitledTask'), icon: 'session' };
}

function buildPivotTree(rows) {
  const groups = new Map();
  for (const row of rows) {
    const place = placeOf(row);
    for (const first of firstLevel(row)) {
      // 펼침 상태가 묶기 방식끼리 섞이지 않게 키에 방식을 붙인다.
      const key = `${groupBy}|${first.key}`;
      if (!groups.has(key)) groups.set(key, folderNode(key, first.label, { icon: first.icon, dot: first.dot, root: true }));
      const root = groups.get(key);
      const placeKey = `${key}/${place.key}`;
      if (!root.folders.has(placeKey)) root.folders.set(placeKey, folderNode(placeKey, place.label, { icon: place.icon, showDir: true }));
      root.folders.get(placeKey).files.push(row);
    }
  }
  return [...groups.values()].map(finish).sort(byLatest);
}

/** 위치로 묶은 파일 줄에는 저장소 안 마지막 폴더를 붙인다. SKILL.md 들이 어느 스킬인지 보이게. */
function dirLeaf(row) {
  const dir = row.location?.dir;
  if (!dir || dir === '/') return null;
  const trimmed = dir.replace(/\/$/, '');
  return { prefix: `${trimmed.split('/').pop()}/`, path: dir };
}

const byLatest = (a, b) => b.latest - a.latest || a.label.localeCompare(b.label, locale());
// 최종본을 먼저, 그다음 최근 순. 라이브러리 목록이 쓰던 순서와 같다.
// 트리의 시각은 에이전트가 마지막으로 손댄 때다. 기간·날짜 묶기와 같은 시각이라 순서가 어긋나지
// 않는다. 기록이 없는 가져온 파일만 파일 수정 시각을 쓴다.
const touchedAt = (row) => row.touched_at ?? row.mtime;
const byImportance = (a, b) => (b.state === 'final') - (a.state === 'final') || touchedAt(b) - touchedAt(a);

/** 개수·최근 시각을 매기고, 파일 없이 폴더 하나만 품은 폴더는 VS Code 처럼 한 줄로 접는다. */
function finish(node) {
  let children = [...node.folders.values()].map(finish);
  while (!node.root && node.files.length === 0 && children.length === 1 && children[0].flatten) {
    const [only] = children;
    node = { ...node, key: only.key, label: `${node.label}/${only.label}`, files: only.files };
    children = only.children;
  }
  node.children = children.sort(byLatest);
  node.files.sort(byImportance);
  node.count = node.files.length + children.reduce((sum, child) => sum + child.count, 0);
  node.latest = Math.max(0, ...node.files.map(touchedAt), ...children.map((child) => child.latest));
  return node;
}

function recordParents(node, ancestors) {
  const chain = [...ancestors, node.key];
  for (const row of node.files) state.parents.set(row.id, chain);
  for (const child of node.children) recordParents(child, chain);
}

/**
 * 파일 하나만 든 끝 폴더는 폴더를 한 번 더 여는 대신 `review/SKILL.md` 로 보여준다. 접힌
 * 경로 전체를 붙이면 좁은 탐색기에서 파일명이 밀려나므로 마지막 폴더 이름만 붙인다.
 */
const flattenedLeaf = (node) =>
  node.flatten && node.children.length === 0 && node.files.length === 1
    ? { row: node.files[0], prefix: `${node.label.split('/').pop()}/`, path: `${node.label}/` }
    : null;

function isOpen(node, level) {
  if (isSearching()) return state.searchOpen[node.key] ?? true;
  return openState[node.key] ?? level === 0;
}

function setOpen(key, open) {
  if (isSearching()) {
    state.searchOpen[key] = open;
    return;
  }
  openState[key] = open;
  prefs.write('tree.open', openState);
}

function renderTree({ keepScroll = false } = {}) {
  const list = $('rows');
  const scroll = list.scrollTop;
  const focused = state.visible.find((entry) => entry.item === document.activeElement)?.id;

  list.setAttribute('role', listRole());
  list.setAttribute('aria-label', t(hasQuery() ? 'aria.results' : 'aria.tree'));
  list.replaceChildren();
  rowNodes.clear();
  state.visible = [];

  if (state.rows.length === 0) {
    list.append(el('li', { className: 'empty' },
      el('p', {}, t(isSearching() ? 'tree.noMatch' : 'tree.empty')),
      isSearching() && el('button', { type: 'button', onclick: resetLibrary }, t('tree.clear'))));
    return;
  }
  // 검색 결과는 서버가 준 관련도순 그대로 한 줄로 세운다. 저장소별로 묶으면 가장 잘 맞은 파일이
  // 최근에 손댄 저장소 아래로 흩어진다.
  if (hasQuery()) for (const row of state.rows) appendFile(list, row, 0);
  else for (const root of state.tree) appendFolder(list, root, 0);

  const active = state.visible.find((entry) => entry.id === (focused ?? state.selected)) ?? state.visible[0];
  if (active) active.item.tabIndex = 0;
  if (keepScroll) list.scrollTop = scroll;
  if (focused !== undefined) active?.item.focus({ preventScroll: true });
}

function appendFolder(list, node, level) {
  const open = isOpen(node, level);
  const entry = { id: node.key, type: 'folder', node, level };
  entry.item = el('li', {
    className: `tree-item folder${node.mono ? ' mono-label' : ''}`,
    tabIndex: -1,
    attrs: { role: 'treeitem', 'aria-level': level + 1, 'aria-expanded': String(open) },
    onclick: () => toggleFolder(entry),
  },
    icon('chevron', 'chevron'),
    node.dot ? el('span', { className: 'dot', attrs: { 'data-provider': node.dot } }) : icon(node.icon),
    el('span', { className: 'tree-label', title: node.label }, node.label),
    el('span', { className: 'tree-count' }, node.count));
  entry.item.style.setProperty('--level', level);
  state.visible.push(entry);
  list.append(entry.item);
  if (!open) return;

  for (const child of node.children) {
    const leaf = flattenedLeaf(child);
    if (leaf) appendFile(list, leaf.row, level + 1, leaf);
    else appendFolder(list, child, level + 1);
  }
  for (const row of node.files) appendFile(list, row, level + 1, node.showDir ? dirLeaf(row) : null);
}

const listRole = () => (hasQuery() ? 'listbox' : 'tree');

function appendFile(list, row, level, leaf = null) {
  // 검색 결과 줄은 트리가 말해 주던 위치를 스스로 말해야 하고, 왜 맞았는지를 덧붙인다.
  const result = hasQuery();
  const text = result ? highlighted : (value) => [value];
  const entry = { id: row.id, type: 'file', row, level };
  entry.item = el('li', {
    className: 'tree-item file',
    tabIndex: -1,
    attrs: {
      role: result ? 'option' : 'treeitem',
      'aria-level': result ? null : level + 1,
      'aria-selected': String(state.selected === row.id),
    },
    onclick: () => {
      focusEntry(entry);
      void select(row.id);
    },
  },
    icon(row.bundle_files ? 'bundle' : KIND_ICON[row.kind] ?? 'doc', 'kind'),
    el('div', { className: 'file-text' },
      el('div', { className: 'file-line' },
        leaf && el('span', { className: 'file-prefix', title: leaf.path }, leaf.prefix),
        el('span', { className: 'file-name' }, ...text(row.file_name)),
        ...badges(row, { compact: true })),
      row.subtitle && el('div', {
        className: 'file-what',
        title: `${subtitleSource(row.subtitle_source)}: ${row.subtitle}`,
      }, ...text(row.subtitle)),
      result && el('div', { className: 'file-where' }, ...locationNodes(row)),
      result && row.excerpt && el('div', { className: 'file-excerpt' }, ...text(row.excerpt))),
    el('span', { className: 'file-when', title: t('tree.touchedAt', { date: fmtDate(touchedAt(row)) }) }, shortWhen(touchedAt(row))));
  entry.item.style.setProperty('--level', level);
  addRowNode(row.id, entry.item);
  state.visible.push(entry);
  list.append(entry.item);
}

function focusEntry(entry) {
  for (const other of state.visible) other.item.tabIndex = -1;
  entry.item.tabIndex = 0;
  entry.item.focus({ preventScroll: true });
  entry.item.scrollIntoView({ block: 'nearest' });
}

function toggleFolder(entry, open = !isOpen(entry.node, entry.level)) {
  setOpen(entry.node.key, open);
  renderTree({ keepScroll: true });
  const again = state.visible.find((e) => e.id === entry.id);
  if (again) focusEntry(again);
}

function collapseAll() {
  const walk = (node) => {
    setOpen(node.key, false);
    node.children.forEach(walk);
  };
  state.tree.forEach(walk);
  renderTree();
}

/** 트리 밖에서 고른 파일(홈, 활동, 같은 내용)을 트리에서도 보이게 조상을 연다. */
function revealInTree(id) {
  if (hasQuery()) return scrollToRow(id);
  const chain = state.parents.get(id);
  if (!chain) return;
  for (const key of chain) setOpen(key, true);
  renderTree({ keepScroll: true });
  scrollToRow(id);
}

function focusTree() {
  const entry = state.visible.find((e) => e.id === state.selected) ?? state.visible[0];
  if (entry) focusEntry(entry);
}

$('rows').addEventListener('keydown', (event) => {
  if (state.mode !== 'library' || event.metaKey || event.ctrlKey || event.altKey) return;
  const at = state.visible.findIndex((e) => e.item === document.activeElement);
  const current = state.visible[at];
  if (!current) return;
  const go = (index) => {
    const target = state.visible[Math.max(0, Math.min(state.visible.length - 1, index))];
    focusEntry(target);
    if (target.type === 'file') void select(target.id);
  };
  const open = current.type === 'folder' && isOpen(current.node, current.level);

  switch (event.key) {
    case 'ArrowDown': go(at + 1); break;
    case 'ArrowUp': go(at - 1); break;
    case 'Home': go(0); break;
    case 'End': go(state.visible.length - 1); break;
    case 'ArrowRight':
      if (current.type !== 'folder') return;
      if (open) go(at + 1);
      else toggleFolder(current, true);
      break;
    case 'ArrowLeft': {
      if (open) {
        toggleFolder(current, false);
        break;
      }
      const parent = state.visible.slice(0, at).reverse().find((e) => e.type === 'folder' && e.level < current.level);
      if (parent) focusEntry(parent);
      break;
    }
    case 'Enter':
    case ' ':
      if (current.type === 'folder') toggleFolder(current);
      else void select(current.id);
      break;
    default:
      return;
  }
  event.preventDefault();
});

// ── 목록 갱신 ───────────────────────────────────────────────────────────

function updateSummary() {
  const count = state.rows.length < state.total
    ? t('summary.partial', { n: state.rows.length, total: state.total })
    : t('summary.count', { n: state.total });
  // 묶기 선택이 사라진 자리에서 지금 순서가 무엇인지 말한다.
  $('summary').textContent = hasQuery() ? `${count} · ${t('summary.ranked')}` : count;
  const trimmed = state.q.trim();
  const shortToken = trimmed.split(/\s+/).some((t) => t && t.length < 3);
  $('hint').textContent = trimmed === '' ? '' : t(shortToken ? 'hint.like' : 'hint.fts');
}

/**
 * 실시간 갱신은 바뀐 게 있을 때만 트리를 다시 그린다. 매번 그리면 보던 자리와 포커스가
 * 30초마다 흔들린다.
 */
async function refresh({ live = false } = {}) {
  renderStats();
  if (state.mode === 'activity') return refreshActivity();

  // 검색 결과는 묶지 않으므로 묶기와 접기가 할 일이 없다.
  $('collapse-all').hidden = hasQuery();
  $('group-by').parentElement.hidden = hasQuery();
  // 종류로 묶을 때 트리가 패싯의 이름표를 쓴다. 트리보다 먼저 받아 둔다.
  const [{ rows, total }] = await Promise.all([
    api(`/api/search?${searchParams({ limit: TREE_LIMIT })}`),
    loadFacets(),
    loadChanges({ live }),
  ]);
  // 새 변경이 오면 파일 줄은 그대로여도 표시("새로")와 개요 목록이 바뀐다.
  const signature = `${state.changes[0]?.id ?? 0}|${rows.map((r) => `${r.id}:${r.mtime}:${r.state}:${r.favorite}`).join(',')}`;
  const changed = !live || signature !== state.signature || $('rows').getAttribute('role') !== listRole();
  state.rows = rows;
  state.total = total ?? rows.length;
  state.signature = signature;
  if (changed) {
    state.tree = buildTree(rows);
    renderTree({ keepScroll: live });
    if (state.view === 'home') void renderHome();
  }
  updateSummary();
  renderFilters(state.facets);
  await refreshOverview();
}

// ── 선택 · 상세 ─────────────────────────────────────────────────────────

function markSelected(id) {
  for (const [rowId, nodes] of rowNodes) for (const node of nodes) node.setAttribute('aria-selected', String(rowId === id));
}

async function select(id, { reveal = false, fromRoute = false } = {}) {
  // 개요에서 파일로 가는 건 기록을 쌓고, 파일에서 파일로는 바꿔 쓴다.
  if (!fromRoute) setRoute(`#/a/${id}`, { replace: state.view === 'detail' });
  const wasWide = $('layout').hasAttribute('data-wide');
  state.view = 'detail';
  updateWide();
  state.selected = id;
  state.rawMode = false;
  state.showAllOrigins = false;
  markSelected(id);
  // 넓은 타임라인이 왼쪽 칸으로 접히면 카드 높이가 달라져 고른 파일이 화면 밖으로 밀린다.
  if (wasWide) scrollToRow(id);
  if (reveal && state.mode === 'library') revealInTree(id);
  else if (reveal) scrollToRow(id);
  const detail = await api(`/api/artifact/${id}`);
  // 화살표를 누르고 있으면 응답이 순서 없이 돌아온다. 마지막으로 고른 것만 그린다.
  if (state.selected !== id) return;
  render(detail);
}

/** 변경 후에는 트리의 배지도 바뀌므로 다시 그리되 선택은 유지한다. */
async function refreshKeepingSelection(detail) {
  render(detail);
  await refresh({ live: true });
}

function move(step) {
  const ids = state.rows.map((r) => r.id);
  if (ids.length === 0) return;
  const at = ids.indexOf(state.selected);
  const next = at < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, at + step));
  void select(ids[next], { reveal: true });
}

const MARKDOWN_EXT = new Set(['md', 'markdown']);
// 에이전트 메모(memo)는 목록에서만 갈라 보는 문서다. 미리보기는 문서와 같다.
const TEXT_KINDS = new Set(['text', 'code', 'memo']);
const isMarkdownDoc = (detail) => (detail.kind === 'text' || detail.kind === 'memo') && MARKDOWN_EXT.has(detail.ext);

const FRAME_STYLE = `
  :root { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  body { margin: 0 auto; max-width: 72ch; padding: 28px 32px 64px;
         font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif;
         color: #1c1c1e; background: #fff; word-break: break-word; }
  :root[data-theme="dark"] body { color: #ececf1; background: #1c1c1e; }
  :root[data-theme="dark"] a { color: #6aa9ff; }
  h1, h2, h3, h4 { margin: 1.4em 0 .5em; line-height: 1.3; text-wrap: balance; }
  h1 { font-size: 1.6em; margin-top: 0; } h2 { font-size: 1.3em; } h3 { font-size: 1.1em; }
  p, ul, ol, blockquote, table { margin: .6em 0; }
  p, li { text-wrap: pretty; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  code { background: rgba(127,127,127,.14); padding: 1px 4px; border-radius: 3px; }
  pre { background: rgba(127,127,127,.1); padding: 12px 14px; border-radius: 6px; overflow-x: auto; line-height: 1.55; }
  pre code { background: none; padding: 0; }
  blockquote { margin-left: 0; padding: 2px 14px; background: rgba(127,127,127,.08); border-radius: 4px; }
  table { border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid rgba(127,127,127,.3); padding: 5px 9px; text-align: left; }
  a { color: #0a66d0; }
  img { max-width: 100%; }
  hr { border: 0; border-top: 1px solid rgba(127,127,127,.3); margin: 2em 0; }
  .fm { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 0 0 2em;
        padding: 12px 14px; font-size: 12.5px; line-height: 1.55; background: rgba(127,127,127,.08); border-radius: 6px; }
  .fm dt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .7; }
  .fm dd { margin: 0; }
  mark { background: #ffe58a; color: inherit; border-radius: 2px; }
  :root[data-theme="dark"] mark { background: #6b5a16; }
  #${PREVIEW_HIT_ID} { scroll-margin-top: 30vh; }
`;

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * marked 는 프런트매터를 모른다. `---` 가 구분선이 되고 그 아래 줄들이 한 덩어리 큰 제목이
 * 되어 SKILL.md 들이 전부 읽기 어려운 첫 화면을 갖는다. 떼어서 작은 키-값 표로 그린다.
 */
function splitFrontmatter(source) {
  const match = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { front: '', body: source };
  const entries = [];
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (pair) entries.push([pair[1], pair[2]]);
    else if (entries.length && line.trim()) entries.at(-1)[1] += ` ${line.trim()}`;
  }
  const rows = entries.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value.replace(/^[>|][+-]?\s*/, ''))}</dd>`);
  return { front: rows.length ? `<dl class="fm">${rows.join('')}</dl>` : '', body: source.slice(match[0].length) };
}

/**
 * 렌더한 마크다운도 에이전트가 만든 내용이다. sandbox="" 는 스크립트를 통째로 막고,
 * 문서 안 meta CSP 가 외부 요청을 막는다 — srcdoc 은 서버 CSP 헤더가 덮지 못한다.
 */
/**
 * 렌더한 HTML 에서 검색어가 맞은 글자만 <mark> 로 감싼다. template 안은 스크립트가 돌지도, 그림을
 * 받아오지도 않는 문서라 에이전트가 쓴 HTML 을 부모에서 풀어도 된다. 결과는 어차피 격리 프레임으로만 간다.
 */
const UNMARKED_PARENTS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE']);
function markHtml(html) {
  const pattern = queryPattern();
  if (!pattern) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!UNMARKED_PARENTS.has(node.parentNode.nodeName)) texts.push(node);
  }
  let budget = MAX_PREVIEW_MARKS;
  for (const node of texts) {
    if (budget <= 0) break;
    const nodes = highlighted(node.data, budget);
    const marks = nodes.filter((part) => part instanceof Node).length;
    if (marks === 0) continue;
    budget -= marks;
    node.replaceWith(...nodes);
  }
  template.content.querySelector('mark')?.setAttribute('id', PREVIEW_HIT_ID);
  return template.innerHTML;
}

function markdownFrame(source, title) {
  const { front, body } = splitFrontmatter(source);
  const html = markHtml(front + (globalThis.marked
    ? globalThis.marked.parse(body, { gfm: true, breaks: false })
    : `<pre>${escapeHtml(body)}</pre>`));
  const frame = el('iframe', { title, referrerPolicy: 'no-referrer' });
  frame.setAttribute('sandbox', '');
  // 격리된 문서라 부모가 스크롤을 시킬 수 없다. 같은 문서 안 이동(#)만은 부모가 시킬 수 있고,
  // 스크립트 없이 된다. 못 하는 브라우저에서는 맨 위에서 열릴 뿐이다.
  if (hasQuery()) {
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow.location.href = `about:srcdoc#${PREVIEW_HIT_ID}`;
      } catch {
        // 맨 위에서 열린다.
      }
    }, { once: true });
  }
  // 격리된 문서라 부모의 data-theme 을 못 본다. 그릴 때의 테마를 박아 넣는다.
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const lang = globalThis.i18n.lang() === 'ko' ? 'ko' : 'en';
  frame.srcdoc = `<!doctype html><html lang="${lang}" data-theme="${theme}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`
    + `<style>${FRAME_STYLE}</style></head><body>${html}</body></html>`;
  return frame;
}

function previewFor(detail) {
  const src = `/artifact/${detail.id}/raw`;
  if (detail.missing_at) {
    return el('div', { className: 'preview-note' },
      el('p', {}, t('preview.missing')),
      el('p', { className: 'hint' }, t('preview.missingNote')));
  }
  if (detail.bundle_files) {
    return el('pre', { className: 'preview-text' }, (detail.members ?? []).join('\n') || t('preview.bundleFiles', { n: detail.bundle_files }));
  }
  if (TEXT_KINDS.has(detail.kind)) {
    return el('div', { className: 'preview-fill', id: 'text-preview' }, el('p', { className: 'preview-note hint' }, t('preview.loading')));
  }
  switch (detail.kind) {
    case 'sheet':
      return sheetPreview(detail);
    case 'image':
      return el('div', { className: 'preview-image' }, el('img', { src, alt: detail.file_name, loading: 'lazy' }));
    case 'pdf':
      return el('embed', { className: 'preview-fill', src, type: 'application/pdf' });
    case 'markup': {
      const frame = el('iframe', { className: 'preview-fill', src, title: detail.file_name, referrerPolicy: 'no-referrer' });
      // allow-same-origin 을 주지 않는다. 불투명 오리진이라 카탈로그 API 나 다른 아티팩트에 닿지 못한다.
      frame.setAttribute('sandbox', detail.allow_scripts ? 'allow-scripts' : '');
      return frame;
    }
    default:
      return el('div', { className: 'preview-note' },
        el('p', {}, t('preview.unsupported')),
        el('button', { type: 'button', onclick: () => post(`/api/artifact/${detail.id}/reveal`, {}) }, t('action.reveal')));
  }
}

// ── 스프레드시트 ─────────────────────────────────────────────────────────
// 서버가 앞부분(행·열 상한)만 값으로 보낸다. 서식·병합·차트는 없다 — 그 사실을 표 아래에 적는다.

const LETTERS = 26;
const CHAR_A = 'A'.charCodeAt(0);
const columnName = (index) => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / LETTERS)) name = String.fromCharCode(CHAR_A + ((n - 1) % LETTERS)) + name;
  return name;
};
const NUMERIC = /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i;
// 엑셀이 저장한 부동소수점 꼬리(0.30000000000000004)를 잘라 보이되 원래 값은 title 에 남긴다.
const SHEET_FRACTION_DIGITS = 6;

function sheetTable(sheet) {
  const head = el('tr', {}, el('th', { className: 'corner' }),
    ...Array.from({ length: sheet.columns }, (_, i) => el('th', {}, columnName(i))));
  const body = sheet.rows.map((row) => el('tr', {}, el('th', {}, row.n),
    ...row.cells.slice(0, sheet.columns).map((value) => NUMERIC.test(value)
      // 'min2' 는 다섯 자리부터 자릿수를 가른다. 연도(2018)가 2,018 로 보이지 않는다.
      ? el('td', { className: 'num', title: value }, Number(value).toLocaleString(locale(), { maximumFractionDigits: SHEET_FRACTION_DIGITS, useGrouping: 'min2' }))
      : el('td', { title: value }, value))));
  return el('div', { className: 'sheet-scroll' },
    el('table', { className: 'sheet-table' }, el('thead', {}, head), el('tbody', {}, ...body)));
}

function sheetPreview(detail) {
  const box = el('div', { className: 'preview-fill sheet' }, el('p', { className: 'preview-note hint' }, t('preview.loading')));
  api(`/api/artifact/${detail.id}/sheet`)
    .then((data) => {
      if (state.selected !== detail.id || !box.isConnected) return;
      if (!data.sheets?.length) {
        box.replaceChildren(el('p', { className: 'preview-note' }, t('sheet.empty')));
        return;
      }
      const tabs = el('div', { className: 'sheet-tabs', attrs: { role: 'tablist' } });
      const body = el('div', { className: 'sheet-body' });
      const show = (index) => {
        const sheet = data.sheets[index];
        tabs.replaceChildren(...keep([...data.sheets.map((each, i) =>
          el('button', {
            type: 'button',
            attrs: { role: 'tab', 'aria-selected': String(i === index) },
            onclick: () => show(i),
          }, each.name || t('sheet.untitled', { n: i + 1 }))),
          data.moreSheets > 0 && el('span', { className: 'sheet-more hint' }, t('sheet.more', { n: data.moreSheets }))]));
        body.replaceChildren(
          sheetTable(sheet),
          el('p', { className: 'sheet-note hint' },
            sheet.truncated ? `${t('sheet.truncated', { rows: sheet.totalRows, cols: sheet.totalCols })} · ` : '',
            t('sheet.valuesOnly')));
      };
      show(0);
      box.replaceChildren(tabs, body);
    })
    .catch(() => {
      if (box.isConnected) box.replaceChildren(el('p', { className: 'preview-note danger' }, t('preview.loadFailed')));
    });
  return box;
}

/** 이 파일을 건드린 세션들. 대표만 보이면 나머지 세션에서 무엇을 했는지가 사라진다. */
function originTimeline(detail) {
  const all = detail.origins;
  const shown = state.showAllOrigins ? all : all.slice(0, ORIGIN_PREVIEW_COUNT);
  const hidden = all.length - shown.length;
  return el('section', {},
    el('h3', {}, t('origins.title', { n: all.length })),
    el('ol', { className: 'origins' },
      ...shown.map((origin) =>
        el('li', {},
          el('div', { className: 'origin-head' },
            el('span', { className: 'chip static', attrs: { 'data-provider': origin.provider ?? 'none' } },
              PROVIDER_LABEL[origin.provider] ?? collectorLabel(origin.collector)),
            el('span', { className: 'when' }, fmtDate(origin.occurred_at)),
            origin.is_deliverable === 1 && el('span', { className: 'badge final' }, t('origins.deliverable'))),
          el('div', { className: 'origin-title' }, origin.session_title ?? t('untitled')),
          origin.workspace && el('div', { className: 'mono dim' }, origin.workspace)))),
    hidden > 0 && el('button', {
      type: 'button',
      className: 'link',
      onclick: () => {
        state.showAllOrigins = true;
        render(detail);
      },
    }, t('origins.more', { n: hidden })));
}

function inspector(detail) {
  const action = (label, handler) => el('button', { type: 'button', className: 'link', onclick: handler }, label);
  const tags = el('div', { className: 'tags' },
    ...detail.tags.map((name) =>
      el('span', { className: 'tag' }, name,
        el('button', {
          type: 'button',
          title: t('tag.remove', { name }),
          onclick: async () => refreshKeepingSelection(await post(`/api/artifact/${detail.id}/untag`, { name })),
        }, '×'))),
    el('button', {
      type: 'button',
      className: 'link',
      onclick: async () => {
        const name = prompt(t('tag.prompt'));
        if (name?.trim()) refreshKeepingSelection(await post(`/api/artifact/${detail.id}/tag`, { name: name.trim() }));
      },
    }, t('tag.add')));

  return el('aside', { className: 'inspector', attrs: { 'aria-label': t('inspector.aria') } }, ...keep([
    el('section', {}, el('h3', {}, t('inspector.origin')),
      el('dl', { className: 'kv' },
        el('dt', {}, t('kv.agent')), el('dd', {}, detail.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(', ') || (detail.collector ? collectorLabel(detail.collector) : '—')),
        el('dt', {}, t('kv.task')), el('dd', {}, detail.session_title ?? '—'),
        el('dt', {}, t('kv.workspace')), el('dd', { className: 'mono' }, detail.workspace ?? '—'),
        el('dt', {}, t('kv.created')), el('dd', {}, fmtDate(detail.created_at ?? detail.mtime)),
        el('dt', {}, t('kv.modified')), el('dd', {}, fmtDate(detail.mtime)),
        el('dt', {}, t('kv.size')), el('dd', {}, fmtBytes(detail.size_bytes)),
        el('dt', {}, t('kv.search')), el('dd', {}, tOr(`bodyState.${detail.body_state}`, t('bodyState.none'))))),

    el('section', {}, el('h3', {}, t('inspector.source')),
      el('p', { className: 'mono path' }, detail.abs_path),
      el('div', { className: 'link-row' },
        action(t('action.copyPath'), () => navigator.clipboard.writeText(detail.abs_path)),
        detail.session_dir && action(t('action.openSession'), () => post(`/api/artifact/${detail.id}/reveal`, { session: true })),
        detail.session_ref && action(t('action.copySession'), () => navigator.clipboard.writeText(detail.session_ref)))),

    detail.prompt && el('section', {}, el('h3', {}, t('inspector.prompt')), el('pre', { className: 'prompt' }, detail.prompt)),

    (detail.origins?.length ?? 0) > 1 && originTimeline(detail),

    el('section', {}, el('h3', {}, t('inspector.tags')), tags),

    el('section', {}, el('h3', {}, t('inspector.note')),
      el('textarea', {
        className: 'note',
        value: detail.note ?? '',
        placeholder: t('note.placeholder'),
        onchange: (event) => post(`/api/artifact/${detail.id}/note`, { note: event.target.value }),
      })),

    detail.duplicates.length > 0 && el('section', {}, el('h3', {}, t('inspector.duplicates', { n: detail.duplicates.length })),
      el('ul', { className: 'duplicates' }, ...detail.duplicates.map((d) =>
        el('li', {},
          el('button', { type: 'button', className: 'link', onclick: () => select(d.id, { reveal: true }) }, d.file_name),
          el('div', { className: 'mono dim' }, d.abs_path))))),
  ]));
}

function render(detail) {
  state.view = 'detail';
  state.detail = detail;
  const toggle = (label, pressed, handler) =>
    el('button', { type: 'button', attrs: { 'aria-pressed': String(pressed) }, onclick: handler }, label);
  const isFinal = detail.state === 'final';
  const made = detail.created_at ?? detail.mtime;

  const head = el('header', { className: 'doc-head' },
    el('div', { className: 'doc-title' },
      el('h2', {}, detail.file_name),
      ...badges(detail),
      detail.stale_final && el('span', { className: 'badge stale' }, t('badge.staleFinal'))),
    detail.subtitle && el('p', {
      className: 'doc-what',
      title: subtitleSource(detail.subtitle_source),
    }, detail.subtitle),
    el('div', { className: 'doc-meta' },
      ...providerChips(detail.providers),
      el('span', { className: 'where' }, ...locationNodes(detail)),
      el('span', { className: 'when', title: fmtDate(made) }, t('detail.created', { when: relativeWhen(made) }))),
    el('div', { className: 'doc-actions' },
      toggle(t(isFinal ? 'action.unmarkFinal' : 'action.markFinal'), isFinal, async () =>
        refreshKeepingSelection(await post(`/api/artifact/${detail.id}/state`, { state: isFinal ? 'discovered' : 'final' }))),
      toggle(t(detail.favorite ? 'action.unfavorite' : 'action.favorite'), Boolean(detail.favorite), async () =>
        refreshKeepingSelection(await post(`/api/artifact/${detail.id}/favorite`, { on: !detail.favorite }))),
      el('button', { type: 'button', onclick: () => post(`/api/artifact/${detail.id}/reveal`, {}) }, t('action.reveal')),
      isMarkdownDoc(detail) && toggle(t('action.raw'), state.rawMode, () => {
        state.rawMode = !state.rawMode;
        render(detail);
      }),
      detail.kind === 'markup' && toggle(t(detail.allow_scripts ? 'action.blockScripts' : 'action.allowScripts'), Boolean(detail.allow_scripts), async () =>
        render(await post(`/api/artifact/${detail.id}/allow-scripts`, { on: !detail.allow_scripts }))),
      el('button', {
        type: 'button',
        className: 'icon-button push',
        title: t(inspectorOpen ? 'panel.close' : 'panel.open'),
        attrs: { 'aria-pressed': String(inspectorOpen), 'aria-label': t('panel.aria') },
        onclick: () => {
          inspectorOpen = !inspectorOpen;
          prefs.write('inspector.open', inspectorOpen);
          render(detail);
        },
      }, icon('panel'))));

  const body = el('div', { className: 'doc-body' },
    el('div', { className: `doc-grid${inspectorOpen ? ' with-inspector' : ''}` },
      el('div', { className: 'doc-preview' }, previewFor(detail)),
      inspectorOpen && inspector(detail)));

  $('detail').replaceChildren(head, body);

  if (TEXT_KINDS.has(detail.kind) && !detail.missing_at && !detail.bundle_files) {
    fetch(`/artifact/${detail.id}/raw`)
      .then((r) => r.text())
      .then((text) => {
        const box = document.getElementById('text-preview');
        if (!box || state.selected !== detail.id) return;
        const rendered = MARKDOWN_EXT.has(detail.ext) && !state.rawMode;
        box.replaceChildren(rendered
          ? markdownFrame(text, detail.file_name)
          : el('pre', { className: 'preview-text' }, ...highlighted(text, MAX_PREVIEW_MARKS)));
        box.querySelector('pre mark')?.scrollIntoView({ block: 'center' });
      })
      .catch(() => {
        const box = document.getElementById('text-preview');
        if (box) box.replaceChildren(el('p', { className: 'preview-note danger' }, t('preview.loadFailed')));
      });
  }
}

// ── 홈 · 수집 범위 ───────────────────────────────────────────────────────

const kbd = (key) => el('kbd', {}, key);

// 분포 한 칸에 보일 줄 수. 나머지는 탐색기 필터에 있다.
const DIST_ROWS = 8;
// 색은 개체를 따른다. 필터로 에이전트가 줄어도 남은 에이전트의 색과 쌓는 순서가 그대로다.
const AGENT_ORDER = ['openai-codex', 'claude-code', 'ai-mesh', 'unknown'];
const agentName = (provider) => (provider === 'unknown' ? t('agent.unknown') : PROVIDER_LABEL[provider] ?? provider);
const TOOLTIP_OFFSET = 8;
const CHART = { plot: 160, top: 10, axis: 22, left: 34, right: 6, maxBar: 18, gap: 2, radius: 4, tickCount: 4 };
let homeToken = 0;

function homeItem(row) {
  return el('li', {},
    el('button', { type: 'button', className: 'home-item', onclick: () => select(row.id, { reveal: true }) },
      el('span', { className: 'home-name' }, row.file_name),
      row.subtitle && el('span', { className: 'home-what' }, row.subtitle),
      el('span', { className: 'home-meta' }, ...locationNodes(row), el('span', { className: 'when' }, relativeWhen(row.mtime)))));
}

let changesObserver = null;

/**
 * 방금 일어난 일. 에이전트 기록으로 본 변화와 디스크를 다시 확인해 본 변화를 구분해 적는다.
 * 목록은 제 높이 안에서 스크롤하고, 끝에 닿으면 이전 쪽을 받는다(보관 30일이라 수천 줄이 될 수 있다).
 */
function changesPanel() {
  changesObserver?.disconnect();
  changesObserver = null;
  if (state.changes.length === 0) {
    return el('section', { className: 'changes' }, el('h3', {}, t('changes.title')), el('p', { className: 'hint' }, t('changes.empty')), hiddenChangesLine());
  }
  const tail = state.changesMore
    ? el('li', { className: 'change-more hint' }, t('changes.loading'))
    : state.changes.length > CHANGE_PAGE_SIZE && el('li', { className: 'change-more hint' }, t('changes.end'));
  const scroller = el('div', { className: 'change-scroll' }, el('ol', { className: 'change-list' }, ...state.changes.map(changeRow), tail));
  if (state.changesMore) {
    changesObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadOlderChanges();
    }, { root: scroller, rootMargin: '0px 0px 120px 0px' });
    changesObserver.observe(tail);
  }
  return el('section', { className: 'changes' }, el('h3', {}, t('changes.title')), scroller, hiddenChangesLine());
}

function changeRow(change) {
  return el('li', {}, el('button', {
    type: 'button',
    className: 'change-item',
    onclick: () => select(change.artifact_id, { reveal: true }),
  },
    el('span', { className: `change-kind change-${change.change}` }, t(`change.${change.change}`)),
    el('span', { className: 'change-name' }, change.file_name),
    el('span', { className: 'change-where' }, ...locationNodes(change)),
    el('span', { className: 'change-tags' }, ...keep([
      ...changeAgents(change),
      change.source === 'disk' && el('span', { className: 'change-outside', title: t('changes.outsideTitle') }, t('changes.outside')),
    ])),
    el('span', { className: 'when', title: fmtDate(change.at) }, relativeWhen(change.at))));
}

/** 이전 쪽을 붙일 때는 개요 전체가 아니라 이 칸만 바꾼다. 그래프를 다시 그리지 않고 스크롤도 그대로다. */
function replaceChangesPanel() {
  const current = document.querySelector('.dash .changes');
  if (!current) return;
  const top = current.querySelector('.change-scroll')?.scrollTop ?? 0;
  const next = changesPanel();
  current.replaceWith(next);
  const scroller = next.querySelector('.change-scroll');
  if (scroller) scroller.scrollTop = top;
}

/**
 * 누가 했나. 에이전트 기록으로 본 변경은 그 에이전트다. 디스크에서 본 변경은 누가 바꿨는지 모르므로
 * 파일을 만든 에이전트를 흐리게 단다 — Codex 가 만든 설정 파일을 앱이 스스로 고친 경우가 실제로 있다.
 * 앱 단위(Codex · Claude Code · Aside)로 단다. 활동 카드와 같은 이름이다.
 */
function changeAgents(change) {
  if (change.source === 'agent') return change.collector ? [agentChip(change.collector)] : [];
  return (change.collectors ?? []).filter((collector) => collector in COLLECTOR_NAME).map((collector) => agentChip(collector, { owner: true }));
}

function agentChip(collector, { owner = false } = {}) {
  const name = collectorLabel(collector);
  return el('span', {
    className: owner ? 'chip static owner' : 'chip static',
    attrs: { 'data-provider': PROVIDER_OF_COLLECTOR[collector] ?? collector, title: owner ? t('changes.ownerTitle', { name }) : null },
  }, name);
}

/** 라이브러리가 숨긴 종류의 변경. 누르면 그 종류로 좁혀 목록과 이 피드에 보인다. */
function hiddenChangesLine() {
  const entries = Object.entries(state.hiddenChanges).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return el('p', { className: 'changes-hidden hint' },
    t('changes.hidden'), ' ',
    ...entries.flatMap(([kind, n], i) => keep([
      i > 0 && ' · ',
      el('button', { type: 'button', className: 'link', onclick: () => toggleFilter('kind', kind) }, t('changes.hiddenKind', { kind: kindLabel(kind), n })),
    ])));
}

function homeList(title, rows, empty) {
  return el('section', { className: 'home-list' },
    el('h3', {}, title),
    rows.length ? el('ul', {}, ...rows.map(homeItem)) : el('p', { className: 'hint' }, empty));
}

function goHome({ fromRoute = false } = {}) {
  state.selected = null;
  markSelected(null);
  if (!fromRoute) setRoute('#/');
  state.view = 'home';
  updateWide();
  // 활동 보기의 개요는 넓은 타임라인 자신이다. 가려진 본문에 개요를 그리지 않는다.
  if (state.mode !== 'activity') void renderHome();
}

/**
 * 아무것도 고르지 않은 본문. 탐색기와 같은 검색어·필터로 센 개요다 — 검색하면 개요도 그
 * 결과의 개요가 된다. 다시 그리는 동안에는 앞 화면을 흐리게 들고 있다(깜빡임 없이).
 */
async function renderHome() {
  state.view = 'home';
  const token = ++homeToken;
  const current = $('detail').querySelector('.dash');
  current?.classList.add('refreshing');
  const scroll = current?.scrollTop ?? 0;
  const feed = current?.querySelector('.change-scroll');
  const feedTop = feed?.scrollTop ?? 0;
  const feedHeight = feed?.scrollHeight ?? 0;
  let activity;
  try {
    activity = await api(`/api/timeline?${searchParams()}`);
  } catch {
    activity = null;
  }
  if (token !== homeToken || state.view !== 'home') return;
  const dash = dashboard(activity);
  $('detail').replaceChildren(dash);
  dash.scrollTop = scroll;
  // 실시간으로 위에 줄이 붙어도 보던 줄이 제자리에 있게 한다. 맨 위를 보고 있었으면 새 줄을 보인다.
  const nextFeed = dash.querySelector('.change-scroll');
  if (nextFeed && feedTop > 0) nextFeed.scrollTop = feedTop + (nextFeed.scrollHeight - feedHeight);
  for (const draw of dash.querySelectorAll('.chart')) draw.dispatchEvent(new Event('draw'));
}

function dashboard(activity) {
  const finals = state.rows.filter((r) => r.state === 'final');
  const repos = new Set(state.rows.map((r) => r.location?.repo).filter(Boolean));

  return el('div', { className: 'dash' },
    el('header', { className: 'dash-head' },
      // 기간은 필터가 아니라 보는 창이다. 제목은 그대로 두고 부제에 기간을 적는다.
      el('h2', {}, t(state.q.trim() ? 'home.search' : Object.keys(state.filters).length ? 'home.filter' : 'home.library')),
      el('p', { className: 'dash-sub' },
        [state.period !== 'all' && t(`periodTitle.${state.period}`), t('home.count', { n: state.total }), t('home.finals', { n: finals.length }), t('home.repos', { n: repos.size })].filter(Boolean).join(' · '))),
    // 목록이 먼저다. 이 화면을 여는 두 순간(찾을 때, 흘끗 볼 때) 모두 몇 달 치 추이보다 방금 바뀐 것과
    // 최종본이 먼저 필요하다. "최근 바뀐 것" 목록은 두지 않는다 — 방금 일어난 일이 같은 파일을
    // 무엇이 · 누가 · 언제까지 더 말한다.
    el('div', { className: 'dash-lists' },
      changesPanel(),
      homeList(t('home.finalsTitle'), finals.slice(0, HOME_LIST_COUNT), t('home.finalsEmpty'))),
    activity ? activityPanel(activity) : el('p', { className: 'hint' }, t('home.activityFailed')),
    distributions(),
    el('p', { className: 'keys' },
      el('span', {}, kbd('↑'), kbd('↓'), ` ${t('keys.move')}`),
      el('span', {}, kbd('←'), kbd('→'), ` ${t('keys.fold')}`),
      el('span', {}, kbd('/'), ` ${t('keys.search')}`)));
}

// ── 개요: 활동 그래프 ───────────────────────────────────────────────────

function orderedAgents(present) {
  return [...AGENT_ORDER.filter((p) => present.includes(p)), ...present.filter((p) => !AGENT_ORDER.includes(p))];
}

const bucketDate = (bucket) => new Date(bucket.start * 1000);

/** 툴팁과 표에 쓰는 칸 이름. 주는 그 주의 월요일로 부른다. */
function bucketLabel(bucket, unit) {
  const date = bucketDate(bucket);
  const day = date.toLocaleDateString(locale(), { month: 'long', day: 'numeric', weekday: unit === 'day' ? 'short' : undefined });
  if (unit === 'hour') return t('chart.hour', { day, hour: date.getHours() });
  return unit === 'week' ? t('chart.week', { day }) : day;
}

/**
 * 축 이름은 골라서 단다. 시간은 6시간마다, 날과 주는 끝(지금)에서 거꾸로 세어 일정 간격마다 —
 * 그래야 맨 오른쪽 칸이 늘 이름을 갖는다.
 */
function axisLabel(bucket, unit, fromEnd, count) {
  const date = bucketDate(bucket);
  if (unit === 'hour') return date.getHours() % 6 === 0 ? t('chart.axisHour', { hour: date.getHours() }) : null;
  const every = unit === 'day'
    ? (count <= 7 ? 1 : count <= 31 ? 7 : 14)
    : (count <= 12 ? 2 : count <= 26 ? 4 : 8);
  if (fromEnd % every !== 0) return null;
  if (unit === 'day' && fromEnd === 0) return t('chart.today');
  return date.toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' });
}

/** 1·2·5 계단으로 반올림한 눈금 간격. 정수만 센다. */
function niceStep(max, count) {
  const raw = Math.max(1, max / count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  return Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude);
}

function activityPanel(activity) {
  const agents = orderedAgents(activity.providers);
  const totals = Object.fromEntries(agents.map((p) => [p, activity.buckets.reduce((sum, b) => sum + (b.counts[p] ?? 0), 0)]));
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  const title = t('chart.title', { period: t(`periodTitle.${activity.period}`) });
  const head = el('div', { className: 'panel-head' },
    el('h3', {}, title),
    agents.length > 1 && el('ul', { className: 'legend' }, ...agents.map((p) =>
      el('li', {}, el('span', { className: 'swatch', attrs: { 'data-provider': p } }), agentName(p),
        el('span', { className: 'legend-n' }, totals[p].toLocaleString(locale()))))));
  if (sum === 0) {
    return el('section', { className: 'panel' }, head, el('p', { className: 'hint' }, t('chart.empty', { period: t(`periodName.${activity.period}`) })));
  }

  const chart = el('div', { className: 'chart' });
  chart.addEventListener('draw', () => drawActivity(chart, activity, agents, title));
  // 폭이 바뀌면 다시 그린다. 글자를 늘리지 않고 막대 간격만 바뀐다.
  let lastWidth = 0;
  new ResizeObserver(() => {
    if (chart.isConnected && Math.abs(chart.clientWidth - lastWidth) > 1) {
      lastWidth = chart.clientWidth;
      drawActivity(chart, activity, agents, title);
    }
  }).observe(chart);

  // 툴팁은 보조다. 같은 숫자를 표로도 읽을 수 있어야 한다.
  const stackOf = (b) => agents.reduce((s, p) => s + (b.counts[p] ?? 0), 0);
  const table = el('details', { className: 'table-view' },
    el('summary', {}, t('chart.table')),
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, t(`unit.${activity.unit}`)), ...agents.map((p) => el('th', {}, agentName(p))), el('th', {}, t('chart.total')))),
      el('tbody', {}, ...[...activity.buckets].reverse().filter((b) => stackOf(b) > 0).map((b) =>
        el('tr', {}, el('th', {}, bucketLabel(b, activity.unit)),
          ...agents.map((p) => el('td', {}, b.counts[p] ?? 0)),
          el('td', {}, stackOf(b)))))));

  return el('section', { className: 'panel' }, head, chart, table);
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** 위 모서리만 둥근 막대 끝. 바닥은 기준선에 붙어 각져 있다. */
function roundedTop(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}

function drawActivity(chart, activity, agents, title) {
  const width = chart.clientWidth;
  if (!width) return;
  const { plot, top, axis, left, right, maxBar, gap, radius, tickCount } = CHART;
  const { buckets, unit } = activity;
  const stackOf = (b) => agents.reduce((s, p) => s + (b.counts[p] ?? 0), 0);
  const peak = Math.max(...buckets.map(stackOf));
  const step = niceStep(peak, tickCount);
  const max = Math.max(step, Math.ceil(peak / step) * step);
  const slot = (width - left - right) / buckets.length;
  const barWidth = Math.max(2, Math.min(maxBar, slot * 0.62));
  const baseline = top + plot;
  const yOf = (value) => baseline - (value / max) * plot;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${top + plot + axis}`,
    width,
    height: top + plot + axis,
    tabindex: 0,
    role: 'group',
    'aria-label': t('chart.aria', { title }),
  });
  for (let value = 0; value <= max; value += step) {
    const y = Math.round(yOf(value)) + 0.5;
    svg.append(svgEl('line', { class: value === 0 ? 'baseline' : 'grid', x1: left, x2: width - right, y1: y, y2: y }));
    const label = svgEl('text', { class: 'axis', x: left - 8, y: y + 3, 'text-anchor': 'end' });
    label.textContent = value.toLocaleString(locale());
    svg.append(label);
  }
  const band = svgEl('rect', { class: 'hover-band', x: 0, y: top, width: slot, height: plot, rx: 4, visibility: 'hidden' });
  svg.append(band);

  buckets.forEach((b, i) => {
    const x = left + i * slot + (slot - barWidth) / 2;
    const present = agents.filter((p) => b.counts[p]);
    let cursor = baseline;
    present.forEach((p, k) => {
      const height = (b.counts[p] / max) * plot;
      const isTop = k === present.length - 1;
      // 조각 사이는 선이 아니라 바탕색 틈으로 가른다.
      const bottomInset = k === 0 ? 0 : gap / 2;
      const topInset = isTop ? 0 : gap / 2;
      const y = cursor - height + topInset;
      const h = Math.max(1, height - topInset - bottomInset);
      svg.append(isTop
        ? svgEl('path', { class: 'seg', 'data-provider': p, d: roundedTop(x, y, barWidth, h, radius) })
        : svgEl('rect', { class: 'seg', 'data-provider': p, x, y, width: barWidth, height: h }));
      cursor -= height;
    });
    const name = axisLabel(b, unit, buckets.length - 1 - i, buckets.length);
    if (name) {
      const label = svgEl('text', { class: 'axis', x: left + i * slot + slot / 2, y: baseline + 15, 'text-anchor': 'middle' });
      label.textContent = name;
      svg.append(label);
    }
  });

  const tooltip = el('div', { className: 'tooltip', attrs: { role: 'status' } });
  tooltip.hidden = true;
  let active = buckets.length - 1;
  const show = (index) => {
    active = Math.max(0, Math.min(buckets.length - 1, index));
    const b = buckets[active];
    band.setAttribute('x', left + active * slot);
    band.setAttribute('visibility', 'visible');
    tooltip.replaceChildren(
      el('div', { className: 'tip-date' }, bucketLabel(b, unit)),
      ...agents.map((p) => el('div', { className: 'tip-row' },
        el('span', { className: 'tip-key', attrs: { 'data-provider': p } }),
        el('span', { className: 'tip-v' }, (b.counts[p] ?? 0).toLocaleString(locale())),
        el('span', { className: 'tip-name' }, agentName(p)))),
      agents.length > 1 && el('div', { className: 'tip-row tip-total' },
        el('span', {}),
        el('span', { className: 'tip-v' }, stackOf(b).toLocaleString(locale())),
        el('span', { className: 'tip-name' }, t('chart.total'))));
    tooltip.hidden = false;
    // 막대 옆에 띄운다. 위에 띄우면 제목과 범례를 덮는다.
    const tipWidth = tooltip.offsetWidth;
    const after = left + (active + 1) * slot + TOOLTIP_OFFSET;
    const before = left + active * slot - TOOLTIP_OFFSET - tipWidth;
    tooltip.style.left = `${after + tipWidth <= width ? after : Math.max(0, before)}px`;
    tooltip.style.top = `${top}px`;
  };
  const hide = () => {
    tooltip.hidden = true;
    band.setAttribute('visibility', 'hidden');
  };
  // 막대가 아니라 칸 전체가 겨냥 대상이다. 가는 막대를 정확히 맞출 필요가 없다.
  svg.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const index = Math.floor((event.clientX - box.left - left) / slot);
    if (index >= 0 && index < buckets.length) show(index);
    else hide();
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(active));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') show(active - 1);
    else if (event.key === 'ArrowRight') show(active + 1);
    else if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(buckets.length - 1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  chart.replaceChildren(svg, tooltip);
}

// ── 개요: 분포 ─────────────────────────────────────────────────────────

/**
 * 패싯 숫자를 막대로 그린다. 사이드바와 같은 숫자라 누르면 같은 필터가 된다. 에이전트만
 * 개체 색을 쓰고 나머지는 한 계열이라 한 색이다 — 크기 순으로 색을 바꾸지 않는다.
 */
function distribution(title, rows, { key, agentColor = false, note = null }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return el('section', { className: 'dist' },
    el('h3', {}, title),
    rows.length
      ? el('ul', {}, ...rows.map((row) =>
          el('li', {}, el('button', {
            type: 'button',
            className: 'dist-row',
            title: row.title ?? t('dist.only', { label: row.label }),
            attrs: { 'aria-pressed': String(state.filters[key] === row.value) },
            onclick: () => toggleFilter(key, row.value),
          },
            el('span', { className: 'dist-label' }, row.label),
            el('span', { className: 'dist-track' },
              el('span', { className: 'dist-bar', attrs: { style: `width: ${(row.n / max) * 100}%`, 'data-provider': agentColor ? row.value : null } })),
            el('span', { className: 'dist-n' }, row.n.toLocaleString(locale()))))))
      : el('p', { className: 'hint' }, t('dist.none')),
    note);
}

function distributions() {
  const facets = state.facets;
  if (!facets) return null;
  const hidden = new Set(facets.libraryHidden ?? []);
  const kinds = facets.kinds.filter((k) => !hidden.has(k.value) || state.filters.kind === k.value);
  const outside = state.filters.kind ? 0 : facets.kinds.filter((k) => hidden.has(k.value)).reduce((s, k) => s + k.n, 0);

  return el('div', { className: 'dash-grid dists' },
    distribution(t('dist.kind'), kinds.slice(0, DIST_ROWS).map((k) => ({ value: k.value, label: kindLabel(k.value), n: k.n })), {
      key: 'kind',
      note: outside > 0 && el('button', {
        type: 'button',
        className: 'link quiet-link dist-note',
        onclick: () => {
          $('filters').open = true;
          facetOpen.kind = true;
          renderFilters(state.facets);
        },
      }, t('dist.outside', { n: outside })),
    }),
    distribution(t('dist.agent'), orderedAgents(facets.providers.map((p) => p.value))
      .map((value) => ({ value, label: agentName(value), n: facets.providers.find((p) => p.value === value).n })), {
      key: 'provider',
      agentColor: true,
    }),
    distribution(t('dist.workspace'), facets.workspaces.slice(0, DIST_ROWS).map((w) =>
      ({ value: w.value, label: workspaceLabel(w.value), title: t('dist.workspaceTitle', { path: w.value }), n: w.n })), {
      key: 'workspace',
    }));
}

// ── 주소 ───────────────────────────────────────────────────────────────
// 개요와 파일을 오가는 길을 브라우저 뒤로 가기에 맡긴다. 파일에서 파일로 옮길 때는 기록을
// 쌓지 않는다 — 화살표로 스무 개를 지나면 뒤로 가기를 스무 번 눌러야 개요로 돌아온다.

function currentRoute() {
  const match = location.hash.match(/^#\/a\/(\d+)$/);
  if (match) return { name: 'artifact', id: Number(match[1]) };
  if (location.hash === '#/coverage') return { name: 'coverage' };
  return { name: 'home' };
}

function setRoute(hash, { replace = false } = {}) {
  const now = location.hash || '#/';
  if (now === hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}

async function applyRoute() {
  const route = currentRoute();
  try {
    if (route.name === 'artifact') await select(route.id, { reveal: true, fromRoute: true });
    else if (route.name === 'coverage') await showCoverage({ fromRoute: true });
    else goHome({ fromRoute: true });
  } catch {
    // 지워진 파일의 주소나 손으로 고친 주소. 개요로 돌아간다.
    history.replaceState(null, '', '#/');
    goHome({ fromRoute: true });
  }
}

window.addEventListener('popstate', () => void applyRoute());


async function showCoverage({ fromRoute = false } = {}) {
  if (!fromRoute) setRoute('#/coverage');
  state.selected = null;
  state.view = 'coverage';
  updateWide();
  markSelected(null);
  const [data, status] = await Promise.all([api('/api/coverage'), api('/api/status')]);
  // 무엇이 왜 빠졌는지에는 "읽으려다 실패했다"도 들어간다. 상단의 수집 오류 표시가 여기로 온다.
  const errors = status.events.filter((event) => event.level === 'error');
  const errorSection = errors.length > 0 && el('section', {},
    el('h3', {}, t('coverage.errors')),
    el('ul', {}, ...errors.map((event) => el('li', {},
      el('span', { className: 'danger' }, `${event.code} · ${relativeWhen(event.at)}`),
      el('div', { className: 'mono' }, [event.message, event.path].filter(Boolean).join(' — '))))));
  const sections = data.sources.map((source) =>
    el('section', {},
      el('p', { className: 'mono' }, source.sessionsRoot),
      el('dl', { className: 'kv' },
        el('dt', {}, t('coverage.sessions')), el('dd', {}, t('coverage.sessionCounts', { total: source.sessions.total, withArtifacts: source.sessions.withArtifacts, empty: source.sessions.empty })),
        el('dt', {}, t('coverage.collected')), el('dd', {}, t('coverage.count', { n: source.collected })),
        el('dt', {}, t('coverage.excluded')), el('dd', {}, t('coverage.count', { n: source.excludedTotal }))),
      el('h3', {}, t('coverage.reasons')),
      el('ul', {}, ...Object.entries(source.excluded)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => el('li', {}, t('coverage.reasonLine', { n, reason: tOr(`reason.${reason}`, reason) })))),
      source.largestGroups.length > 0 && el('h3', {}, t('coverage.largest')),
      source.largestGroups.length > 0 && el('ul', {},
        ...source.largestGroups.map((g) => el('li', {}, el('span', { className: 'mono' }, g.name), t('coverage.groupLine', { n: g.files })))),
      el('p', { className: 'hint' },
        t('coverage.note'))),
  );
  $('detail').replaceChildren(el('div', { className: 'page' }, el('h2', {}, t('coverage.title')), errorSection, ...sections.flat().filter(Boolean)));
}

// ── 활동 보기 ────────────────────────────────────────────────────────────
// 같은 데이터를 파일이 아니라 작업 단위로 본다. "어느 에이전트가 어느 저장소에서
// 무엇을 했나"가 단위라, 트리가 아니라 세션 타임라인으로 그린다.

function sessionCard(session) {
  const files = session.files.map((file) => {
    const node = el('button', {
      type: 'button',
      className: `session-file${file.state === 'final' ? ' final' : ''}`,
      title: file.file_name,
      attrs: { 'aria-selected': String(state.selected === file.id) },
      onclick: () => select(file.id),
    }, file.bundle_files ? `${file.file_name}/ (${file.bundle_files})` : file.file_name);
    addRowNode(file.id, node);
    return node;
  });
  const hidden = session.file_count - session.files.length;

  return el('li', { className: 'session' },
    el('div', { className: 'session-head' },
      el('span', { className: 'when' }, relativeWhen(session.at)),
      el('span', { className: 'chip static', attrs: { 'data-provider': PROVIDER_OF_COLLECTOR[session.collector] ?? session.collector } }, collectorLabel(session.collector)),
      session.workspace && el('span', { className: 'where-dir' }, session.workspace.split('/').slice(-2).join('/')),
      session.final_count > 0 && el('span', { className: 'badge final' }, t('session.final', { n: session.final_count })),
      // 대화 하나가 띄운 서브에이전트 중 파일을 만든 스레드 수. 큰 작업인지 한눈에 보인다.
      session.subagent_count > 0 && el('span', { className: 'badge multi' }, t('session.subagents', { n: session.subagent_count }))),
    el('div', { className: 'session-title' }, session.session_title ?? t('untitled')),
    el('div', { className: 'session-files' }, ...files,
      hidden > 0 && el('span', { className: 'session-more' }, t('session.more', { n: hidden }))),
  );
}

async function refreshActivity() {
  const { sessions } = await api(`/api/activity?${activityParams()}`);

  const list = $('rows');
  list.setAttribute('role', 'list');
  list.replaceChildren();
  rowNodes.clear();
  state.visible = [];
  state.rows = sessions.flatMap((s) => s.files);
  state.total = sessions.length;
  state.signature = '';
  $('collapse-all').hidden = true;
  $('group-by').parentElement.hidden = true;

  if (sessions.length === 0) list.append(el('li', { className: 'empty' }, el('p', {}, t('activity.empty'))));
  for (const session of sessions) list.append(sessionCard(session));

  $('summary').textContent = t('activity.summary', { n: sessions.length });
  $('hint').textContent = '';
  await Promise.all([refreshFacets(), refreshOverview()]);
}

// ── 탐색기 폭 ───────────────────────────────────────────────────────────

function setExplorerWidth(px, { save = true } = {}) {
  const width = Math.round(Math.max(EXPLORER_WIDTH.min, Math.min(EXPLORER_WIDTH.max, px)));
  $('layout').style.setProperty('--explorer-width', `${width}px`);
  $('resizer').setAttribute('aria-valuenow', width);
  if (save) prefs.write('explorer.width', width);
}

const resizer = $('resizer');
resizer.setAttribute('aria-valuemin', EXPLORER_WIDTH.min);
resizer.setAttribute('aria-valuemax', EXPLORER_WIDTH.max);
setExplorerWidth(prefs.read('explorer.width', EXPLORER_WIDTH.initial), { save: false });

resizer.addEventListener('pointerdown', (event) => {
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
  const left = $('layout').getBoundingClientRect().left;
  const onMove = (moveEvent) => setExplorerWidth(moveEvent.clientX - left);
  const onUp = () => {
    resizer.removeEventListener('pointermove', onMove);
    document.body.classList.remove('resizing');
  };
  resizer.addEventListener('pointermove', onMove);
  resizer.addEventListener('pointerup', onUp, { once: true });
  resizer.addEventListener('pointercancel', onUp, { once: true });
});
resizer.addEventListener('keydown', (event) => {
  const now = Number(resizer.getAttribute('aria-valuenow'));
  if (event.key === 'ArrowLeft') setExplorerWidth(now - EXPLORER_WIDTH.step);
  else if (event.key === 'ArrowRight') setExplorerWidth(now + EXPLORER_WIDTH.step);
  else return;
  event.preventDefault();
});

// ── 입력 ───────────────────────────────────────────────────────────────

let debounce;
$('q').addEventListener('input', (event) => {
  state.q = event.target.value;
  state.searchOpen = {};
  clearTimeout(debounce);
  // 검색어가 바뀌면 결과는 맨 위부터다. 트리를 내려 보던 자리가 남으면 가장 잘 맞은 결과가 위로 가려진다.
  debounce = setTimeout(() => void refresh().then(() => { $('rows').scrollTop = 0; }), SEARCH_DEBOUNCE_MS);
});
$('coverage').addEventListener('click', () => void showCoverage());
$('collapse-all').append(icon('collapse'));
function renderGroupBy() {
  $('group-by').replaceChildren(...GROUPINGS.map((value) => el('option', { value, selected: value === groupBy }, t(`group.${value}`))));
}
renderGroupBy();
$('group-by').addEventListener('change', (event) => {
  groupBy = event.target.value;
  prefs.write('tree.groupBy', groupBy);
  state.tree = buildTree(state.rows);
  renderTree();
});
$('collapse-all').addEventListener('click', collapseAll);
$('mode-library').addEventListener('click', () => setMode('library'));
$('mode-activity').addEventListener('click', () => setMode('activity'));

$('filters').open = prefs.read('filters.open', false);
$('filters').addEventListener('toggle', () => prefs.write('filters.open', $('filters').open));

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const typing = event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA';
  if (event.target === $('q') && event.key === 'ArrowDown' && state.mode === 'library') {
    event.preventDefault();
    focusTree();
    return;
  }
  if (typing) return;
  if (event.key === '/' || event.key === 'Escape') {
    event.preventDefault();
    $('q').focus();
    $('q').select();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (state.mode === 'activity') {
    event.preventDefault();
    move(event.key === 'ArrowDown' ? 1 : -1);
  } else if (!$('rows').contains(event.target)) {
    event.preventDefault();
    focusTree();
  }
});

$('sweep').addEventListener('click', async () => {
  $('sweep').disabled = true;
  $('sweep').textContent = t('sweep.running');
  try {
    await post('/api/sweep');
    await refresh({ live: true });
  } finally {
    $('sweep').disabled = false;
    $('sweep').textContent = t('sweep.idle');
  }
});

// ── 실시간 ───────────────────────────────────────────────────────────────
// 수집이 한 바퀴 돌 때마다 서버가 알려준다. 트리는 바뀐 게 있을 때만 다시 그린다.

let liveTimer;
let lastCollectedAt = null;

function renderLive(status) {
  $('live').dataset.status = status;
  $('live').textContent = status === 'down'
    ? t('live.down')
    : lastCollectedAt ? t('live.collected', { when: relativeWhen(lastCollectedAt) }) : t('live.up');
  renderCollectError();
}

// 수집은 30초마다 다시 성공하므로 초록 점만으로는 한 번 난 실패가 보이지 않는다. 글자로 따로 말한다.
let collectError = null;
const collectErrorButton = el('button', { type: 'button', className: 'link danger', hidden: true, onclick: () => void showCoverage() });
$('live').after(collectErrorButton);
function renderCollectError() {
  collectErrorButton.hidden = !collectError;
  if (!collectError) return;
  collectErrorButton.textContent = t('live.error', { when: relativeWhen(collectError.at) });
  collectErrorButton.title = [collectError.code, collectError.message, collectError.path].filter(Boolean).join(' · ');
}

function connectLive() {
  const source = new EventSource('/api/events');
  source.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if ('error' in payload) collectError = payload.error;
    if (payload.type === 'failed' || payload.type === 'hello') renderCollectError();
    if (payload.type !== 'collected') return;
    lastCollectedAt = payload.at;
    renderLive('up');
    clearTimeout(liveTimer);
    // 짧은 간격의 연속 이벤트를 한 번으로 모은다.
    liveTimer = setTimeout(() => void refresh({ live: true }), LIVE_COALESCE_MS);
  });
  // EventSource 는 스스로 재연결한다. 새 연결을 만들면 중복 구독이 된다.
  source.addEventListener('error', () => renderLive('down'));
  source.addEventListener('open', () => renderLive('up'));
}

setInterval(() => {
  if ($('live').dataset.status === 'up') renderLive('up');
}, MINUTE * 1000);

$('home').addEventListener('click', () => goHome());

// ── 언어 ───────────────────────────────────────────────────────────────
// 이름은 각 언어가 자기를 부르는 말이라 번역하지 않는다.
const LANG_NAME = { ko: '한국어', en: 'English' };
const LANG_SHORT = { ko: 'KO', en: 'EN' };

function renderLang() {
  const current = globalThis.i18n.lang();
  $('lang').replaceChildren(...globalThis.i18n.LANGS.map((code) =>
    el('button', {
      type: 'button',
      lang: code,
      title: LANG_NAME[code],
      attrs: { role: 'radio', 'aria-checked': String(code === current), 'aria-label': LANG_NAME[code] },
      onclick: () => globalThis.i18n.set(code),
    }, LANG_SHORT[code])));
}

/**
 * 언어가 바뀌면 그려 둔 것을 전부 다시 그린다. 정적 문구는 i18n.js 가 이미 바꿨다 — 여기서는
 * 코드가 만든 문구(트리 묶음 이름, 필터, 개요, 상세)를 새 언어로 다시 만든다.
 */
document.addEventListener('langchange', () => {
  renderLang();
  renderPeriod();
  renderGroupBy();
  renderThemeButton();
  renderVersion();
  setModeState(state.mode);
  if ($('live').dataset.status) renderLive($('live').dataset.status);
  if (state.view === 'detail' && state.detail) render(state.detail);
  else if (state.view === 'coverage') void showCoverage({ fromRoute: true });
  void refresh();
});
renderLang();
renderPeriod();

// 버전은 바닥줄에 작게 둔다. 자주 보는 정보가 아니라 버그를 알리거나 새 버전이 받아졌는지 볼 때 쓴다.
let version = null;
function renderVersion() {
  if (!version) return;
  $('version').textContent = `v${version}`;
  $('version').title = t('version.title', { version });
}
api('/api/version')
  .then((info) => {
    version = info.version;
    renderVersion();
  })
  .catch(() => {
    // 버전을 못 받아도 화면은 그대로 쓴다.
  });

// ── 테마 ───────────────────────────────────────────────────────────────
// 시스템 설정 → 라이트 → 다크 순서로 돈다. 정하는 일은 theme.js 가 하고 여기는 버튼만 그린다.

const THEME_ICON = { system: 'auto', light: 'sun', dark: 'moon' };
const nextTheme = () => {
  const { CHOICES } = globalThis.theme;
  return CHOICES[(CHOICES.indexOf(globalThis.theme.choice()) + 1) % CHOICES.length];
};

function renderThemeButton() {
  const choice = globalThis.theme.choice();
  const label = t('theme.label', { current: t(`theme.${choice}`), next: t(`theme.${nextTheme()}`) });
  $('theme').replaceChildren(icon(THEME_ICON[choice]));
  $('theme').title = label;
  $('theme').setAttribute('aria-label', label);
}

$('theme').addEventListener('click', () => globalThis.theme.set(nextTheme()));
document.addEventListener('themechange', () => {
  renderThemeButton();
  // 렌더한 마크다운은 격리된 문서라 스스로 바뀌지 못한다. 보고 있으면 다시 그린다.
  const detail = state.detail;
  if (state.view === 'detail' && detail && isMarkdownDoc(detail) && !state.rawMode) render(detail);
});
renderThemeButton();
await refresh();
await applyRoute();
connectLive();
