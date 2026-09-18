const $ = (id) => document.getElementById(id);

// 서버가 MAX_SEARCH_LIMIT 에서 자른다. 트리는 저장소별로 묶어야 해서 라이브러리 전체가 필요하다.
const TREE_LIMIT = 5000;
// 한 파일을 최대 17세션이 건드렸다. 전부 펼치면 정보 패널을 덮는다.
const ORIGIN_PREVIEW_COUNT = 8;
const HOME_LIST_COUNT = 6;
const EXPLORER_WIDTH = { min: 240, max: 560, step: 16, initial: 340 };
const LIVE_COALESCE_MS = 400;
const SEARCH_DEBOUNCE_MS = 120;
const ACTIVITY_FILTERS = new Set(['collector', 'workspace']);
// 기간 값은 서버의 PERIOD_DAYS 키와 같다. 시작 시각은 서버가 정한다 — 목록·현황·그래프가 같은 자정을 쓴다.
const PERIODS = [['all', '전체'], ['today', '오늘'], ['7d', '7일'], ['30d', '30일'], ['90d', '90일']];
const PERIOD_TITLE = { all: '전체 기간 · 주별', today: '오늘 · 시간별', '7d': '최근 7일', '30d': '최근 30일', '90d': '최근 90일' };
const PERIOD_NAME = { all: '지금까지', today: '오늘', '7d': '최근 7일 동안', '30d': '최근 30일 동안', '90d': '최근 90일 동안' };
const UNIT_HEADER = { hour: '시각', day: '날짜', week: '주' };
// 탐색기 트리의 첫 단. 저장소가 기본이고, 나머지는 첫 단만 바꾸고 둘째 단은 위치(저장소·작업)다.
const GROUPINGS = { repo: '저장소', provider: '에이전트', collector: '앱', date: '날짜', kind: '종류' };

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
let groupBy = GROUPINGS[prefs.read('tree.groupBy', 'repo')] ? prefs.read('tree.groupBy', 'repo') : 'repo';

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
const fmtDate = (unix) => (unix ? new Date(unix * 1000).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function relativeWhen(unix) {
  const age = Date.now() / 1000 - unix;
  if (age < MINUTE) return '방금';
  if (age < HOUR) return `${Math.floor(age / MINUTE)}분 전`;
  if (age < DAY) return `${Math.floor(age / HOUR)}시간 전`;
  return age < WEEK ? `${Math.floor(age / DAY)}일 전` : fmtDate(unix);
}

/** 트리 한 줄에 들어가는 짧은 시각. 일주일이 넘으면 날짜만. */
function shortWhen(unix) {
  const age = Date.now() / 1000 - unix;
  if (age < HOUR) return `${Math.max(1, Math.floor(age / MINUTE))}분`;
  if (age < DAY) return `${Math.floor(age / HOUR)}시간`;
  if (age < WEEK) return `${Math.floor(age / DAY)}일`;
  const date = new Date(unix * 1000);
  return `${date.getMonth() + 1}. ${date.getDate()}.`;
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
const KIND_ICON = { text: 'doc', code: 'doc', office: 'doc', other: 'doc', markup: 'web', image: 'image', sheet: 'sheet', pdf: 'pdf', bundle: 'bundle' };

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
const COLLECTOR_LABEL = { codex: 'Codex', 'claude-code': 'Claude Code', aside: 'Aside', import: '가져옴' };
const STATE_LABEL = { discovered: '발견', final: '최종본' };
// 활동 카드는 수집기 이름을 단다. Aside 가 실어 온 Claude 세션에 Claude 색을 칠하면 수집기를 잘못 말한다.
const PROVIDER_OF_COLLECTOR = { codex: 'openai-codex', 'claude-code': 'claude-code' };
const FILTER_LABEL = { kind: '종류', provider: '에이전트', collector: '수집기', state: '상태', ext: '형식', tag: '태그', workspace: '작업공간' };
const SUBTITLE_SOURCE_LABEL = { doc: '문서 제목', task: '만든 작업' };
const BODY_STATE_LABEL = { indexed: '전문 검색 가능', skipped: '전문 검색 불가', failed: '본문 추출 실패', pending: '색인 대기' };

/** 출처에서 파생된 분류. 누르면 그 에이전트로 좁힌다 — 행 선택과 겹치지 않게 전파를 끊는다. */
function providerChips(providers) {
  return (providers ?? []).map((provider) =>
    el('button', {
      type: 'button',
      className: 'chip',
      title: `${PROVIDER_LABEL[provider] ?? provider} 만 보기`,
      attrs: { 'data-provider': provider },
      onclick: (event) => {
        event.stopPropagation();
        toggleFilter('provider', provider);
      },
    }, PROVIDER_LABEL[provider] ?? provider));
}

function badges(row, { compact = false } = {}) {
  return keep([
    // 여러 에이전트가 손댄 파일은 충돌이 아니라 중요도의 신호다.
    // SQLite 불리언은 0/1 이다. `0 && …` 은 0 을 남겨 화면에 "0" 이 찍힌다.
    !compact && (row.providers?.length ?? 0) > 1 && el('span', { className: 'badge multi' }, `에이전트 ${row.providers.length}`),
    !compact && Boolean(row.bundle_files) && el('span', { className: 'badge' }, `폴더 · ${row.bundle_files}개`),
    Boolean(row.missing_at) && el('span', { className: 'badge missing' }, '원본 없음'),
    row.state === 'final' && el('span', { className: 'badge final' }, '최종본'),
    Boolean(row.favorite) && el('span', { className: 'badge fav', title: '즐겨찾기' }, '★'),
  ]);
}

/** 저장소 안이면 저장소 이름 + 저장소 안 경로, 밖이면 실제 경로, 작업공간이 없으면 수집기. */
function locationNodes(row) {
  const where = row.location;
  if (!where) return [el('span', {}, COLLECTOR_LABEL[row.collector] ?? '가져옴')];
  return keep([
    where.repo && el('span', { className: 'where-repo' }, where.repo),
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

function renderPeriod() {
  $('period').replaceChildren(...PERIODS.map(([value, label]) =>
    el('button', {
      type: 'button',
      attrs: { role: 'radio', 'aria-checked': String(state.period === value) },
      onclick: () => setPeriod(value),
    }, label)));
}

function setPeriod(period) {
  state.period = period;
  state.searchOpen = {};
  renderPeriod();
  void refresh();
}

function setModeState(mode) {
  state.mode = mode;
  $('mode-library').setAttribute('aria-selected', String(mode === 'library'));
  $('mode-activity').setAttribute('aria-selected', String(mode === 'activity'));
  $('q').disabled = mode === 'activity';
  $('q').placeholder = mode === 'activity' ? '활동 보기는 시간순이라 검색하지 않습니다' : '파일명 · 본문 · 작업 검색';
}

function setMode(mode) {
  setModeState(mode);
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

function filterDisplay(key, value) {
  switch (key) {
    case 'favorite': return '즐겨찾기';
    case 'kind': return state.facets?.kinds.find((k) => k.value === value)?.label ?? value;
    case 'provider': return `${FILTER_LABEL.provider}: ${PROVIDER_LABEL[value] ?? value}`;
    case 'collector': return `${FILTER_LABEL.collector}: ${COLLECTOR_LABEL[value] ?? value}`;
    case 'state': return STATE_LABEL[value] ?? value;
    case 'workspace': return `${FILTER_LABEL.workspace}: ${String(value).split('/').pop()}`;
    default: return `${FILTER_LABEL[key] ?? key}: ${value}`;
  }
}

function renderActiveFilters() {
  const tokens = Object.entries(state.filters).map(([key, value]) =>
    el('button', {
      type: 'button',
      className: 'token',
      title: '이 필터 지우기',
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

async function refreshFacets() {
  renderFilters(await loadFacets());
}

function renderFilters(data) {
  const hidden = new Set(data.libraryHidden ?? []);
  const shorten = (path) => path.split('/').slice(-2).join('/');
  const groups = state.mode === 'activity'
    ? [
        ['collector', '수집기', data.collectors.map((c) => ({ ...c, display: COLLECTOR_LABEL[c.value] ?? c.value }))],
        ['workspace', '작업공간', (data.workspaces ?? []).map((w) => ({ ...w, display: shorten(w.value) }))],
      ]
    : [
        ['kind', '종류', data.kinds.map((k) => ({ ...k, display: k.label }))],
        ['provider', '에이전트', data.providers.map((p) => ({ ...p, display: PROVIDER_LABEL[p.value] ?? p.value }))],
        ['state', '상태', data.states.map((s) => ({ ...s, display: STATE_LABEL[s.value] ?? s.value }))],
        ['ext', '형식', data.exts],
        ['collector', '수집기', data.collectors.map((c) => ({ ...c, display: COLLECTOR_LABEL[c.value] ?? c.value }))],
        ['tag', '태그', data.tags],
      ];

  const favorite = state.mode === 'library' && el('button', {
    type: 'button',
    className: 'facet',
    attrs: { 'aria-pressed': String(Boolean(state.filters.favorite)) },
    onclick: () => toggleFilter('favorite', true),
  }, el('span', { className: 'facet-name' }, '★ 즐겨찾기만'));

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
          title: outOfScope ? '라이브러리 밖입니다. 누르면 이 종류만 봅니다' : String(item.value),
          attrs: { 'aria-pressed': String(active === item.value) },
          onclick: () => toggleFilter(key, item.value),
        },
          el('span', { className: 'facet-name' }, item.display ?? item.value),
          outOfScope && el('span', { className: 'facet-note' }, '라이브러리 밖'),
          el('span', { className: 'n' }, item.n.toLocaleString('ko-KR')));
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
        title: '코드와 모르는 형식은 라이브러리에서 숨깁니다. 종류 필터로 꺼내 볼 수 있습니다',
        onclick: () => {
          $('filters').open = true;
          facetOpen.kind = true;
          renderFilters(state.facets);
        },
      }, `라이브러리 밖 ${outside.toLocaleString('ko-KR')}개`)
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
      el('span', { className: 'stat-n' }, n.toLocaleString('ko-KR')),
      el('span', { className: 'stat-label' }, label));
  $('stats').replaceChildren(
    stat(numbers.library, '라이브러리', {
      pressed: state.mode === 'library' && !isSearching(),
      onclick: resetLibrary,
      title: '검색어와 필터를 지우고 라이브러리 전체 보기',
    }),
    stat(numbers.final, '최종본', {
      pressed: state.mode === 'library' && state.filters.state === 'final',
      onclick: () => toggleFilter('state', 'final'),
      title: '최종본으로 표시한 것만 보기',
    }),
    stat(numbers.recent, `최근 ${numbers.recentDays}일`, {
      pressed: state.period === numbers.recentPeriod,
      onclick: () => setPeriod(state.period === numbers.recentPeriod ? 'all' : numbers.recentPeriod),
      title: `최근 ${numbers.recentDays}일 동안 에이전트가 손댄 것만 보기 (기간 선택과 같다)`,
    }),
    stat(numbers.activeConversations, `${numbers.activeHours}시간 내 작업`, {
      pressed: state.mode === 'activity',
      onclick: () => setMode(state.mode === 'activity' ? 'library' : 'activity'),
      title: `최근 ${numbers.activeHours}시간 동안 파일을 쓴 대화. 누르면 활동 보기`,
    }),
  );
}

// ── 탐색기 트리 ─────────────────────────────────────────────────────────
// 저장소 → 폴더 → 파일. 위치 정보(describe.mjs)를 그대로 경로로 쓴다. 작업공간이 없는
// Aside 산출물은 수집기 아래 작업 제목으로 묶는다 — 거기서는 작업이 곧 폴더다.

function treePlacement(row) {
  const where = row.location;
  if (where?.repo) {
    return {
      group: { key: `repo:${where.repo}`, label: where.repo, icon: 'repo' },
      folders: where.dir === '/' ? [] : where.dir.replace(/\/$/, '').split('/'),
      folderIcon: 'folder',
      flatten: true,
    };
  }
  if (where) {
    return {
      group: { key: 'elsewhere', label: '저장소 밖', icon: 'folder' },
      folders: [where.dir.replace(/\/$/, '')],
      folderIcon: 'folder',
      mono: true,
    };
  }
  return {
    group: { key: `collector:${row.collector}`, label: COLLECTOR_LABEL[row.collector] ?? '가져옴', icon: 'session' },
    folders: [row.session_title ?? '제목 없는 작업'],
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
  if (unix >= today) return { key: 'today', label: '오늘' };
  if (unix >= today - DAY) return { key: 'yesterday', label: '어제' };
  if (unix >= today - 6 * DAY) return { key: 'week', label: '지난 7일' };
  if (unix >= today - 29 * DAY) return { key: 'month', label: '지난 30일' };
  const date = new Date(unix * 1000);
  return { key: `${date.getFullYear()}-${date.getMonth() + 1}`, label: `${date.getFullYear()}년 ${date.getMonth() + 1}월` };
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
        : [{ key: 'unknown', label: '에이전트 모름', icon: 'session' }];
    case 'collector':
      return (row.collectors?.length ? row.collectors : [row.collector]).map((c) =>
        ({ key: c, label: COLLECTOR_LABEL[c] ?? c, dot: PROVIDER_OF_COLLECTOR[c] ?? c }));
    case 'date':
      return [{ ...dateBucket(touchedAt(row)), icon: 'date' }];
    default:
      return [{ key: row.kind ?? 'unknown', label: state.facets?.kinds.find((k) => k.value === row.kind)?.label ?? row.kind ?? '미분류', icon: KIND_ICON[row.kind] ?? 'doc' }];
  }
}

/** 둘째 단은 어디서: 저장소, 저장소 밖, 작업공간이 없으면 작업 제목. */
function placeOf(row) {
  const where = row.location;
  if (where?.repo) return { key: `repo:${where.repo}`, label: where.repo, icon: 'repo' };
  if (where) return { key: 'elsewhere', label: '저장소 밖', icon: 'folder' };
  return { key: `task:${row.collector}:${row.session_title ?? ''}`, label: row.session_title ?? '제목 없는 작업', icon: 'session' };
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

const byLatest = (a, b) => b.latest - a.latest || a.label.localeCompare(b.label, 'ko');
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

  list.setAttribute('role', 'tree');
  list.replaceChildren();
  rowNodes.clear();
  state.visible = [];

  if (state.rows.length === 0) {
    list.append(el('li', { className: 'empty' },
      el('p', {}, isSearching() ? '맞는 산출물이 없습니다.' : '아직 수집된 산출물이 없습니다.'),
      isSearching() && el('button', { type: 'button', onclick: resetLibrary }, '검색어와 필터 지우기')));
    return;
  }
  for (const root of state.tree) appendFolder(list, root, 0);

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

function appendFile(list, row, level, leaf = null) {
  const entry = { id: row.id, type: 'file', row, level };
  entry.item = el('li', {
    className: 'tree-item file',
    tabIndex: -1,
    attrs: { role: 'treeitem', 'aria-level': level + 1, 'aria-selected': String(state.selected === row.id) },
    onclick: () => {
      focusEntry(entry);
      void select(row.id);
    },
  },
    icon(row.bundle_files ? 'bundle' : KIND_ICON[row.kind] ?? 'doc', 'kind'),
    el('div', { className: 'file-text' },
      el('div', { className: 'file-line' },
        leaf && el('span', { className: 'file-prefix', title: leaf.path }, leaf.prefix),
        el('span', { className: 'file-name' }, row.file_name),
        ...badges(row, { compact: true })),
      row.subtitle && el('div', {
        className: 'file-what',
        title: `${SUBTITLE_SOURCE_LABEL[row.subtitle_source] ?? ''}: ${row.subtitle}`,
      }, row.subtitle)),
    el('span', { className: 'file-when', title: `에이전트가 손댄 때 ${fmtDate(touchedAt(row))}` }, shortWhen(touchedAt(row))));
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
  const total = state.total.toLocaleString('ko-KR');
  $('summary').textContent = state.rows.length < state.total ? `${total}개 중 ${state.rows.length}개` : `${total}개`;
  const trimmed = state.q.trim();
  const shortToken = trimmed.split(/\s+/).some((t) => t && t.length < 3);
  $('hint').textContent = trimmed === '' ? '' : shortToken ? '부분 일치' : '전문 검색';
}

/**
 * 실시간 갱신은 바뀐 게 있을 때만 트리를 다시 그린다. 매번 그리면 보던 자리와 포커스가
 * 30초마다 흔들린다.
 */
async function refresh({ live = false } = {}) {
  renderStats();
  if (state.mode === 'activity') return refreshActivity();

  $('collapse-all').hidden = false;
  $('group-by').parentElement.hidden = false;
  // 종류로 묶을 때 트리가 패싯의 이름표를 쓴다. 트리보다 먼저 받아 둔다.
  const [{ rows, total }] = await Promise.all([
    api(`/api/search?${searchParams({ limit: TREE_LIMIT })}`),
    loadFacets(),
  ]);
  const signature = rows.map((r) => `${r.id}:${r.mtime}:${r.state}:${r.favorite}`).join(',');
  const changed = !live || signature !== state.signature || $('rows').getAttribute('role') !== 'tree';
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
  state.view = 'detail';
  state.selected = id;
  state.rawMode = false;
  state.showAllOrigins = false;
  markSelected(id);
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
const TEXT_KINDS = new Set(['text', 'code']);

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
function markdownFrame(source, title) {
  const { front, body } = splitFrontmatter(source);
  const html = front + (globalThis.marked
    ? globalThis.marked.parse(body, { gfm: true, breaks: false })
    : `<pre>${escapeHtml(body)}</pre>`);
  const frame = el('iframe', { title, referrerPolicy: 'no-referrer' });
  frame.setAttribute('sandbox', '');
  // 격리된 문서라 부모의 data-theme 을 못 본다. 그릴 때의 테마를 박아 넣는다.
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  frame.srcdoc = `<!doctype html><html lang="ko" data-theme="${theme}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`
    + `<style>${FRAME_STYLE}</style></head><body>${html}</body></html>`;
  return frame;
}

function previewFor(detail) {
  const src = `/artifact/${detail.id}/raw`;
  if (detail.missing_at) {
    return el('div', { className: 'preview-note' },
      el('p', {}, '원본 파일이 사라졌습니다.'),
      el('p', { className: 'hint' }, '기록, 태그, 메모는 그대로 남아 있습니다.'));
  }
  if (detail.bundle_files) {
    return el('pre', { className: 'preview-text' }, (detail.members ?? []).join('\n') || `${detail.bundle_files}개 파일`);
  }
  if (TEXT_KINDS.has(detail.kind)) {
    return el('div', { className: 'preview-fill', id: 'text-preview' }, el('p', { className: 'preview-note hint' }, '불러오는 중…'));
  }
  switch (detail.kind) {
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
        el('p', {}, '이 형식은 미리보기를 지원하지 않습니다.'),
        el('button', { type: 'button', onclick: () => post(`/api/artifact/${detail.id}/reveal`, {}) }, 'Finder에서 보기'));
  }
}

/** 이 파일을 건드린 세션들. 대표만 보이면 나머지 세션에서 무엇을 했는지가 사라진다. */
function originTimeline(detail) {
  const all = detail.origins;
  const shown = state.showAllOrigins ? all : all.slice(0, ORIGIN_PREVIEW_COUNT);
  const hidden = all.length - shown.length;
  return el('section', {},
    el('h3', {}, `출처 · 세션 ${all.length}개`),
    el('ol', { className: 'origins' },
      ...shown.map((origin) =>
        el('li', {},
          el('div', { className: 'origin-head' },
            el('span', { className: 'chip static', attrs: { 'data-provider': origin.provider ?? 'none' } },
              PROVIDER_LABEL[origin.provider] ?? COLLECTOR_LABEL[origin.collector] ?? origin.collector),
            el('span', { className: 'when' }, fmtDate(origin.occurred_at)),
            origin.is_deliverable === 1 && el('span', { className: 'badge final' }, '산출물')),
          el('div', { className: 'origin-title' }, origin.session_title ?? '(제목 없음)'),
          origin.workspace && el('div', { className: 'mono dim' }, origin.workspace)))),
    hidden > 0 && el('button', {
      type: 'button',
      className: 'link',
      onclick: () => {
        state.showAllOrigins = true;
        render(detail);
      },
    }, `${hidden}개 더 보기`));
}

function inspector(detail) {
  const action = (label, handler) => el('button', { type: 'button', className: 'link', onclick: handler }, label);
  const tags = el('div', { className: 'tags' },
    ...detail.tags.map((name) =>
      el('span', { className: 'tag' }, name,
        el('button', {
          type: 'button',
          title: `${name} 태그 떼기`,
          onclick: async () => refreshKeepingSelection(await post(`/api/artifact/${detail.id}/untag`, { name })),
        }, '×'))),
    el('button', {
      type: 'button',
      className: 'link',
      onclick: async () => {
        const name = prompt('태그 이름');
        if (name?.trim()) refreshKeepingSelection(await post(`/api/artifact/${detail.id}/tag`, { name: name.trim() }));
      },
    }, '+ 태그 달기'));

  return el('aside', { className: 'inspector', attrs: { 'aria-label': '정보' } }, ...keep([
    el('section', {}, el('h3', {}, '원 작업'),
      el('dl', { className: 'kv' },
        el('dt', {}, '에이전트'), el('dd', {}, detail.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(', ') || (COLLECTOR_LABEL[detail.collector] ?? '—')),
        el('dt', {}, '작업'), el('dd', {}, detail.session_title ?? '—'),
        el('dt', {}, '작업공간'), el('dd', { className: 'mono' }, detail.workspace ?? '—'),
        el('dt', {}, '만든 때'), el('dd', {}, fmtDate(detail.created_at ?? detail.mtime)),
        el('dt', {}, '바뀐 때'), el('dd', {}, fmtDate(detail.mtime)),
        el('dt', {}, '크기'), el('dd', {}, fmtBytes(detail.size_bytes)),
        el('dt', {}, '검색'), el('dd', {}, BODY_STATE_LABEL[detail.body_state] ?? '색인 없음'))),

    el('section', {}, el('h3', {}, '원본'),
      el('p', { className: 'mono path' }, detail.abs_path),
      el('div', { className: 'link-row' },
        action('경로 복사', () => navigator.clipboard.writeText(detail.abs_path)),
        detail.session_dir && action('세션 폴더 열기', () => post(`/api/artifact/${detail.id}/reveal`, { session: true })),
        detail.session_ref && action('세션 id 복사', () => navigator.clipboard.writeText(detail.session_ref)))),

    detail.prompt && el('section', {}, el('h3', {}, '원본 요청'), el('pre', { className: 'prompt' }, detail.prompt)),

    (detail.origins?.length ?? 0) > 1 && originTimeline(detail),

    el('section', {}, el('h3', {}, '태그'), tags),

    el('section', {}, el('h3', {}, '메모'),
      el('textarea', {
        className: 'note',
        value: detail.note ?? '',
        placeholder: '이 산출물에 대해 남길 말',
        onchange: (event) => post(`/api/artifact/${detail.id}/note`, { note: event.target.value }),
      })),

    detail.duplicates.length > 0 && el('section', {}, el('h3', {}, `같은 내용 ${detail.duplicates.length}개`),
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
      detail.stale_final && el('span', { className: 'badge stale' }, '최종본 표시 뒤 바뀜')),
    detail.subtitle && el('p', {
      className: 'doc-what',
      title: SUBTITLE_SOURCE_LABEL[detail.subtitle_source] ?? '',
    }, detail.subtitle),
    el('div', { className: 'doc-meta' },
      ...providerChips(detail.providers),
      el('span', { className: 'where' }, ...locationNodes(detail)),
      el('span', { className: 'when', title: fmtDate(made) }, `만든 때 ${relativeWhen(made)}`)),
    el('div', { className: 'doc-actions' },
      toggle(isFinal ? '최종본 해제' : '최종본으로 표시', isFinal, async () =>
        refreshKeepingSelection(await post(`/api/artifact/${detail.id}/state`, { state: isFinal ? 'discovered' : 'final' }))),
      toggle(detail.favorite ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기', Boolean(detail.favorite), async () =>
        refreshKeepingSelection(await post(`/api/artifact/${detail.id}/favorite`, { on: !detail.favorite }))),
      el('button', { type: 'button', onclick: () => post(`/api/artifact/${detail.id}/reveal`, {}) }, 'Finder에서 보기'),
      detail.kind === 'text' && MARKDOWN_EXT.has(detail.ext) && toggle('원문 보기', state.rawMode, () => {
        state.rawMode = !state.rawMode;
        render(detail);
      }),
      detail.kind === 'markup' && toggle(detail.allow_scripts ? '스크립트 차단' : '스크립트 허용', Boolean(detail.allow_scripts), async () =>
        render(await post(`/api/artifact/${detail.id}/allow-scripts`, { on: !detail.allow_scripts }))),
      el('button', {
        type: 'button',
        className: 'icon-button push',
        title: inspectorOpen ? '정보 패널 닫기' : '정보 패널 열기',
        attrs: { 'aria-pressed': String(inspectorOpen), 'aria-label': '정보 패널' },
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
        box.replaceChildren(rendered ? markdownFrame(text, detail.file_name) : el('pre', { className: 'preview-text' }, text));
      })
      .catch(() => {
        const box = document.getElementById('text-preview');
        if (box) box.replaceChildren(el('p', { className: 'preview-note danger' }, '불러오지 못했습니다.'));
      });
  }
}

// ── 홈 · 수집 범위 ───────────────────────────────────────────────────────

const kbd = (key) => el('kbd', {}, key);

// 분포 한 칸에 보일 줄 수. 나머지는 탐색기 필터에 있다.
const DIST_ROWS = 8;
// 색은 개체를 따른다. 필터로 에이전트가 줄어도 남은 에이전트의 색과 쌓는 순서가 그대로다.
const AGENT_ORDER = ['openai-codex', 'claude-code', 'ai-mesh', 'unknown'];
const agentName = (provider) => (provider === 'unknown' ? '에이전트 모름' : PROVIDER_LABEL[provider] ?? provider);
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

function homeList(title, rows, empty) {
  return el('section', { className: 'home-list' },
    el('h3', {}, title),
    rows.length ? el('ul', {}, ...rows.map(homeItem)) : el('p', { className: 'hint' }, empty));
}

function goHome({ fromRoute = false } = {}) {
  state.selected = null;
  markSelected(null);
  if (!fromRoute) setRoute('#/');
  void renderHome();
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
  for (const draw of dash.querySelectorAll('.chart')) draw.dispatchEvent(new Event('draw'));
}

function dashboard(activity) {
  const finals = state.rows.filter((r) => r.state === 'final');
  const recent = state.rows.filter((r) => r.state !== 'final').sort((a, b) => b.mtime - a.mtime);
  const repos = new Set(state.rows.map((r) => r.location?.repo).filter(Boolean));
  const total = state.total.toLocaleString('ko-KR');

  return el('div', { className: 'dash' },
    el('header', { className: 'dash-head' },
      // 기간은 필터가 아니라 보는 창이다. 제목은 그대로 두고 부제에 기간을 적는다.
      el('h2', {}, state.q.trim() ? '검색 결과 개요' : Object.keys(state.filters).length ? '필터 결과 개요' : '라이브러리 개요'),
      el('p', { className: 'dash-sub' },
        [state.period !== 'all' && PERIOD_TITLE[state.period], `${total}개`, `최종본 ${finals.length}개`, `저장소 ${repos.size}곳`].filter(Boolean).join(' · '))),
    activity ? activityPanel(activity) : el('p', { className: 'hint' }, '활동 기록을 불러오지 못했습니다.'),
    distributions(),
    el('div', { className: 'dash-grid' },
      homeList('최종본', finals.slice(0, HOME_LIST_COUNT), '최종본으로 표시한 산출물이 아직 없습니다.'),
      homeList('최근 바뀐 것', recent.slice(0, HOME_LIST_COUNT), '최근 바뀐 산출물이 없습니다.')),
    el('p', { className: 'keys' },
      el('span', {}, kbd('↑'), kbd('↓'), ' 이동'),
      el('span', {}, kbd('←'), kbd('→'), ' 접기 · 펼치기'),
      el('span', {}, kbd('/'), ' 검색')));
}

// ── 개요: 활동 그래프 ───────────────────────────────────────────────────

function orderedAgents(present) {
  return [...AGENT_ORDER.filter((p) => present.includes(p)), ...present.filter((p) => !AGENT_ORDER.includes(p))];
}

const bucketDate = (bucket) => new Date(bucket.start * 1000);

/** 툴팁과 표에 쓰는 칸 이름. 주는 그 주의 월요일로 부른다. */
function bucketLabel(bucket, unit) {
  const date = bucketDate(bucket);
  const day = date.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: unit === 'day' ? 'short' : undefined });
  if (unit === 'hour') return `${day} ${date.getHours()}시`;
  return unit === 'week' ? `${day} 주` : day;
}

/**
 * 축 이름은 골라서 단다. 시간은 6시간마다, 날과 주는 끝(지금)에서 거꾸로 세어 일정 간격마다 —
 * 그래야 맨 오른쪽 칸이 늘 이름을 갖는다.
 */
function axisLabel(bucket, unit, fromEnd, count) {
  const date = bucketDate(bucket);
  if (unit === 'hour') return date.getHours() % 6 === 0 ? `${date.getHours()}시` : null;
  const every = unit === 'day'
    ? (count <= 7 ? 1 : count <= 31 ? 7 : 14)
    : (count <= 12 ? 2 : count <= 26 ? 4 : 8);
  if (fromEnd % every !== 0) return null;
  if (unit === 'day' && fromEnd === 0) return '오늘';
  return `${date.getMonth() + 1}/${date.getDate()}`;
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
  const title = `${PERIOD_TITLE[activity.period]} · 에이전트가 쓴 산출물`;
  const head = el('div', { className: 'panel-head' },
    el('h3', {}, title),
    agents.length > 1 && el('ul', { className: 'legend' }, ...agents.map((p) =>
      el('li', {}, el('span', { className: 'swatch', attrs: { 'data-provider': p } }), agentName(p),
        el('span', { className: 'legend-n' }, totals[p].toLocaleString('ko-KR'))))));
  if (sum === 0) {
    return el('section', { className: 'panel' }, head, el('p', { className: 'hint' }, `${PERIOD_NAME[activity.period]} 에이전트가 쓴 산출물이 없습니다.`));
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
    el('summary', {}, '표로 보기'),
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, UNIT_HEADER[activity.unit]), ...agents.map((p) => el('th', {}, agentName(p))), el('th', {}, '합계'))),
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
    'aria-label': `${title}. 좌우 화살표로 칸을 옮깁니다`,
  });
  for (let value = 0; value <= max; value += step) {
    const y = Math.round(yOf(value)) + 0.5;
    svg.append(svgEl('line', { class: value === 0 ? 'baseline' : 'grid', x1: left, x2: width - right, y1: y, y2: y }));
    const label = svgEl('text', { class: 'axis', x: left - 8, y: y + 3, 'text-anchor': 'end' });
    label.textContent = value.toLocaleString('ko-KR');
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
        el('span', { className: 'tip-v' }, (b.counts[p] ?? 0).toLocaleString('ko-KR')),
        el('span', { className: 'tip-name' }, agentName(p)))),
      agents.length > 1 && el('div', { className: 'tip-row tip-total' },
        el('span', {}),
        el('span', { className: 'tip-v' }, stackOf(b).toLocaleString('ko-KR')),
        el('span', { className: 'tip-name' }, '합계')));
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
            title: row.title ?? `${row.label}만 보기`,
            attrs: { 'aria-pressed': String(state.filters[key] === row.value) },
            onclick: () => toggleFilter(key, row.value),
          },
            el('span', { className: 'dist-label' }, row.label),
            el('span', { className: 'dist-track' },
              el('span', { className: 'dist-bar', attrs: { style: `width: ${(row.n / max) * 100}%`, 'data-provider': agentColor ? row.value : null } })),
            el('span', { className: 'dist-n' }, row.n.toLocaleString('ko-KR'))))))
      : el('p', { className: 'hint' }, '없음'),
    note);
}

function distributions() {
  const facets = state.facets;
  if (!facets) return null;
  const hidden = new Set(facets.libraryHidden ?? []);
  const kinds = facets.kinds.filter((k) => !hidden.has(k.value) || state.filters.kind === k.value);
  const outside = state.filters.kind ? 0 : facets.kinds.filter((k) => hidden.has(k.value)).reduce((s, k) => s + k.n, 0);

  return el('div', { className: 'dash-grid dists' },
    distribution('종류', kinds.slice(0, DIST_ROWS).map((k) => ({ value: k.value, label: k.label, n: k.n })), {
      key: 'kind',
      note: outside > 0 && el('button', {
        type: 'button',
        className: 'link quiet-link dist-note',
        onclick: () => {
          $('filters').open = true;
          facetOpen.kind = true;
          renderFilters(state.facets);
        },
      }, `라이브러리 밖 ${outside.toLocaleString('ko-KR')}개 (코드 · 기타)`),
    }),
    distribution('에이전트', orderedAgents(facets.providers.map((p) => p.value))
      .map((value) => ({ value, label: agentName(value), n: facets.providers.find((p) => p.value === value).n })), {
      key: 'provider',
      agentColor: true,
    }),
    distribution('작업공간', facets.workspaces.slice(0, DIST_ROWS).map((w) =>
      ({ value: w.value, label: w.value.split('/').pop(), title: `${w.value} 에서 에이전트가 만든 것만 보기`, n: w.n })), {
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

const REASON_LABEL = {
  'too-deep': '중첩 폴더 (스캐폴딩된 프로젝트)',
  dotfile: '점으로 시작하는 파일 (.git 등)',
  'excluded-dir': '제외 폴더 (tmp · attachments)',
  'not-artifacts-dir': '산출물 폴더 밖 (transcript 등)',
  'unsafe-path': '안전하지 않은 경로',
  symlink: '심볼릭 링크',
};

async function showCoverage({ fromRoute = false } = {}) {
  if (!fromRoute) setRoute('#/coverage');
  state.selected = null;
  state.view = 'coverage';
  markSelected(null);
  const data = await api('/api/coverage');
  const sections = data.sources.map((source) =>
    el('section', {},
      el('p', { className: 'mono' }, source.sessionsRoot),
      el('dl', { className: 'kv' },
        el('dt', {}, '세션'), el('dd', {}, `${source.sessions.total}개 (산출물 있음 ${source.sessions.withArtifacts}, 비어 있음 ${source.sessions.empty})`),
        el('dt', {}, '수집'), el('dd', {}, `${source.collected}개`),
        el('dt', {}, '제외'), el('dd', {}, `${source.excludedTotal}개`)),
      el('h3', {}, '제외 이유'),
      el('ul', {}, ...Object.entries(source.excluded)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => el('li', {}, `${n}개: ${REASON_LABEL[reason] ?? reason}`))),
      source.largestGroups.length > 0 && el('h3', {}, '제외된 가장 큰 묶음'),
      source.largestGroups.length > 0 && el('ul', {},
        ...source.largestGroups.map((g) => el('li', {}, el('span', { className: 'mono' }, g.name), `: ${g.files}개`))),
      el('p', { className: 'hint' },
        '에이전트가 산출물 폴더 안에 프로젝트를 통째로 만들면 그 파일들은 제외됩니다. 산출물 폴더 바로 아래 파일만 수집합니다.')),
  );
  $('detail').replaceChildren(el('div', { className: 'page' }, el('h2', {}, '수집 범위'), ...sections.flat().filter(Boolean)));
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
      el('span', { className: 'chip static', attrs: { 'data-provider': PROVIDER_OF_COLLECTOR[session.collector] ?? session.collector } }, COLLECTOR_LABEL[session.collector] ?? session.collector),
      session.workspace && el('span', { className: 'where-dir' }, session.workspace.split('/').slice(-2).join('/')),
      session.final_count > 0 && el('span', { className: 'badge final' }, `최종본 ${session.final_count}`),
      // 대화 하나가 띄운 서브에이전트 중 파일을 만든 스레드 수. 큰 작업인지 한눈에 보인다.
      session.subagent_count > 0 && el('span', { className: 'badge multi' }, `서브에이전트 ${session.subagent_count}`)),
    el('div', { className: 'session-title' }, session.session_title ?? '(제목 없음)'),
    el('div', { className: 'session-files' }, ...files,
      hidden > 0 && el('span', { className: 'session-more' }, `외 ${hidden}개`)),
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

  if (sessions.length === 0) list.append(el('li', { className: 'empty' }, el('p', {}, '최근 활동이 없습니다.')));
  for (const session of sessions) list.append(sessionCard(session));

  $('summary').textContent = `최근 작업 ${sessions.length}건`;
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
  debounce = setTimeout(() => void refresh(), SEARCH_DEBOUNCE_MS);
});
$('coverage').addEventListener('click', () => void showCoverage());
$('collapse-all').append(icon('collapse'));
$('group-by').replaceChildren(...Object.entries(GROUPINGS).map(([value, label]) => el('option', { value, selected: value === groupBy }, label)));
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
  $('sweep').textContent = '수집 중…';
  try {
    await post('/api/sweep');
    await refresh({ live: true });
  } finally {
    $('sweep').disabled = false;
    $('sweep').textContent = '다시 수집';
  }
});

// ── 실시간 ───────────────────────────────────────────────────────────────
// 수집이 한 바퀴 돌 때마다 서버가 알려준다. 트리는 바뀐 게 있을 때만 다시 그린다.

let liveTimer;
let lastCollectedAt = null;

function renderLive(status) {
  $('live').dataset.status = status;
  $('live').textContent = status === 'down'
    ? '연결 끊김'
    : lastCollectedAt ? `실시간 · ${relativeWhen(lastCollectedAt)} 수집` : '실시간';
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
renderPeriod();

// ── 테마 ───────────────────────────────────────────────────────────────
// 시스템 설정 → 라이트 → 다크 순서로 돈다. 정하는 일은 theme.js 가 하고 여기는 버튼만 그린다.

const THEME_ICON = { system: 'auto', light: 'sun', dark: 'moon' };
const THEME_LABEL = { system: '시스템 설정', light: '라이트', dark: '다크' };
const nextTheme = () => {
  const { CHOICES } = globalThis.theme;
  return CHOICES[(CHOICES.indexOf(globalThis.theme.choice()) + 1) % CHOICES.length];
};

function renderThemeButton() {
  const choice = globalThis.theme.choice();
  const label = `테마: ${THEME_LABEL[choice]}. 누르면 ${THEME_LABEL[nextTheme()]}`;
  $('theme').replaceChildren(icon(THEME_ICON[choice]));
  $('theme').title = label;
  $('theme').setAttribute('aria-label', label);
}

$('theme').addEventListener('click', () => globalThis.theme.set(nextTheme()));
document.addEventListener('themechange', () => {
  renderThemeButton();
  // 렌더한 마크다운은 격리된 문서라 스스로 바뀌지 못한다. 보고 있으면 다시 그린다.
  const detail = state.detail;
  if (state.view === 'detail' && detail && detail.kind === 'text' && MARKDOWN_EXT.has(detail.ext) && !state.rawMode) render(detail);
});
renderThemeButton();
await refresh();
await applyRoute();
connectLive();
