// 화면 문구 사전. app.js 보다 먼저 동기로 돌아서 정적 문구를 첫 그림 전에 바꾼다 — 모듈에서
// 바꾸면 영어를 고른 사람에게 한국어가 한 번 번쩍인다. 고른 언어는 이 브라우저에만 남는다.
(() => {
  const KEY = 'aoc.lang';
  const LANGS = ['ko', 'en'];
  const LOCALE = { ko: 'ko-KR', en: 'en-US' };

  const detect = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (LANGS.includes(saved)) return saved;
    } catch {
      // 저장이 막힌 창. 브라우저 언어로 정한다.
    }
    return (navigator.languages ?? [navigator.language]).some((l) => String(l).toLowerCase().startsWith('ko')) ? 'ko' : 'en';
  };
  let lang = detect();

  const num = (n) => Number(n).toLocaleString(LOCALE[lang]);
  // 한국어는 수를 세도 모양이 같지만 영어는 1 과 나머지가 다르다.
  const count = (n, one, other) => `${num(n)} ${Number(n) === 1 ? one : other}`;

  const MESSAGES = {
    ko: {
      'brand.home': '개요로 가기',
      'nodes.aria': '노드', 'nodes.here': '이 기기', 'nodes.open': ({ name }) => `${name} 의 카탈로그 열기`,
      'aria.modes': '보기',
      'mode.library': '라이브러리',
      'mode.activity': '활동',
      'aria.stats': '현황',
      'sweep.idle': '다시 수집',
      'sweep.running': '수집 중…',
      'aria.explorer': '탐색기',
      'search.placeholder': '파일명 · 본문 · 작업 검색',
      'search.disabled': '활동 보기는 시간순이라 검색하지 않습니다',
      'period.label': '기간',
      'filters.label': '필터',
      'groupBy.label': '묶기',
      'groupBy.aria': '트리 묶기 기준',
      'tree.collapseAll': '모두 접기',
      'aria.tree': '산출물',
      'aria.results': '검색 결과 · 관련도순',
      'coverage.link': '수집 범위',
      'aria.resizer': '탐색기 폭',
      'aria.content': '내용',
      'importer.title': '폴더 가져오기',
      'importer.close': '닫기',
      'importer.confirm': '이 폴더 가져오기',
      'lang.aria': '언어',

      'period.all': '전체', 'period.today': '오늘', 'period.7d': '7일', 'period.30d': '30일', 'period.90d': '90일',
      'periodTitle.all': '전체 기간 · 주별', 'periodTitle.today': '오늘 · 시간별',
      'periodTitle.7d': '최근 7일', 'periodTitle.30d': '최근 30일', 'periodTitle.90d': '최근 90일',
      'periodName.all': '지금까지', 'periodName.today': '오늘',
      'periodName.7d': '최근 7일 동안', 'periodName.30d': '최근 30일 동안', 'periodName.90d': '최근 90일 동안',
      'unit.hour': '시각', 'unit.day': '날짜', 'unit.week': '주',
      'group.repo': '저장소', 'group.provider': '에이전트', 'group.collector': '앱', 'group.date': '날짜', 'group.kind': '종류',

      'time.justNow': '방금',
      'short.minutes': ({ n }) => `${n}분`, 'short.hours': ({ n }) => `${n}시간`, 'short.days': ({ n }) => `${n}일`,

      'collector.import': '가져옴',
      'state.discovered': '발견', 'state.final': '최종본',
      'filter.kind': '종류', 'filter.provider': '에이전트', 'filter.collector': '앱', 'filter.state': '상태',
      'filter.ext': '형식', 'filter.tag': '태그', 'filter.workspace': '작업공간', 'filter.favorite': '즐겨찾기',
      'subtitle.doc': '문서 제목', 'subtitle.task': '만든 작업',
      'bodyState.indexed': '전문 검색 가능', 'bodyState.skipped': '전문 검색 불가',
      'bodyState.failed': '본문 추출 실패', 'bodyState.pending': '색인 대기', 'bodyState.none': '색인 없음',
      'kind.text': '문서', 'kind.code': '코드', 'kind.bundle': '폴더', 'kind.markup': '웹 페이지', 'kind.pdf': 'PDF',
      'kind.sheet': '스프레드시트', 'kind.office': '오피스 문서', 'kind.image': '이미지', 'kind.other': '기타',
      'kind.memo': '에이전트 메모',
      'kind.unclassified': '미분류',

      'chip.only': ({ name }) => `${name} 만 보기`,
      'badge.agents': ({ n }) => `에이전트 ${n}`,
      'badge.bundle': ({ n }) => `폴더 · ${num(n)}개`,
      'badge.missing': '원본 없음', 'badge.final': '최종본', 'badge.favorite': '즐겨찾기',
      'badge.staleFinal': '최종본 표시 뒤 바뀜',

      'filter.clearOne': '이 필터 지우기',
      'facet.favoritesOnly': '★ 즐겨찾기만',
      'facet.outOfScopeTitle': '라이브러리 밖입니다. 누르면 이 종류만 봅니다',
      'facet.outOfScope': '라이브러리 밖',
      'facet.outsideTitle': '코드, 에이전트 메모, 모르는 형식은 라이브러리에서 숨깁니다. 종류 필터로 꺼내 볼 수 있습니다',
      'facet.outsideCount': ({ n }) => `라이브러리 밖 ${num(n)}개`,

      'stat.library': '라이브러리', 'stat.libraryTitle': '검색어와 필터를 지우고 라이브러리 전체 보기',
      'stat.final': '최종본', 'stat.finalTitle': '최종본으로 표시한 것만 보기',
      'stat.recent': ({ n }) => `최근 ${n}일`,
      'stat.recentTitle': ({ n }) => `최근 ${n}일 동안 에이전트가 손댄 것만 보기 (기간 선택과 같다)`,
      'stat.active': ({ n }) => `${n}시간 내 작업`,
      'stat.activeTitle': ({ n }) => `최근 ${n}시간 동안 파일을 쓴 대화. 누르면 활동 보기`,

      'where.worktree': ({ name }) => `git worktree: ${name}`,
      'tree.elsewhere': '저장소 밖', 'tree.untitledTask': '제목 없는 작업', 'agent.unknown': '에이전트 모름',
      'date.today': '오늘', 'date.yesterday': '어제', 'date.week': '지난 7일', 'date.month': '지난 30일',
      'tree.noMatch': '맞는 산출물이 없습니다.', 'tree.empty': '아직 수집된 산출물이 없습니다.',
      'tree.clear': '검색어와 필터 지우기',
      'tree.touchedAt': ({ date }) => `에이전트가 손댄 때 ${date}`,
      'summary.count': ({ n }) => `${num(n)}개`,
      'summary.partial': ({ n, total }) => `${num(total)}개 중 ${num(n)}개`,
      'summary.ranked': '관련도순',
      'hint.like': '부분 일치', 'hint.fts': '전문 검색',

      'preview.missing': '원본 파일이 사라졌습니다.', 'preview.missingNote': '기록, 태그, 메모는 그대로 남아 있습니다.',
      'preview.bundleFiles': ({ n }) => `${num(n)}개 파일`,
      'action.backToBundle': '← 구성 파일',
      'preview.loading': '불러오는 중…', 'preview.unsupported': '이 형식은 미리보기를 지원하지 않습니다.',
      'preview.loadFailed': '불러오지 못했습니다.',
      'sheet.empty': '보여줄 시트가 없습니다.',
      'change.created': '새로 생김', 'change.modified': '바뀜', 'change.moved': '옮김',
      'change.missing': '사라짐', 'change.restored': '돌아옴',
      'fresh.created': '새로', 'fresh.modified': '바뀜', 'fresh.moved': '옮김', 'fresh.restored': '돌아옴',
      'changes.title': '방금 일어난 일',
      'changes.empty': '아직 변경 기록이 없습니다. 에이전트가 파일을 만들거나 고치면 여기에 바로 나타납니다.',
      'changes.outside': '디스크에서 발견',
      'version.title': ({ version }) => `Output Mesh 버전 ${version}`,
      'changes.outsideTitle': '에이전트 기록이 아니라 디스크에서 직접 알게 된 변화입니다. 사람이 고쳤거나 에이전트가 셸 명령으로 썼을 수 있습니다',
      'changes.ownerTitle': ({ name }) => `만든 에이전트: ${name}. 이번 변경은 디스크에서 발견해 누가 했는지는 모릅니다`,
      'changes.loading': '이전 기록 불러오는 중…',
      'changes.end': '더 이전 기록은 없습니다',
      'changes.hidden': '라이브러리가 숨긴 변경:',
      'changes.hiddenKind': ({ kind, n }) => `${kind} ${num(n)}개`,
      'collector.workspace': '저장소 문서',
      'sheet.untitled': ({ n }) => `시트 ${n}`,
      'sheet.more': ({ n }) => `시트 ${num(n)}개 더 (미리보기 생략)`,
      'sheet.truncated': ({ rows, cols }) => `앞부분만 보입니다 (전체 ${num(rows)}행 × ${num(cols)}열)`,
      'sheet.valuesOnly': '값만 보여줍니다. 서식, 병합, 차트는 보이지 않고 수식은 계산된 값이 나옵니다.',

      'origins.title': ({ n }) => `출처 · 세션 ${num(n)}개`,
      'origins.deliverable': '산출물', 'untitled': '(제목 없음)',
      'origins.more': ({ n }) => `${num(n)}개 더 보기`,
      'tag.remove': ({ name }) => `${name} 태그 떼기`, 'tag.prompt': '태그 이름', 'tag.add': '+ 태그 달기',

      'inspector.aria': '정보', 'inspector.origin': '원 작업',
      'kv.agent': '에이전트', 'kv.task': '작업', 'kv.workspace': '작업공간', 'kv.created': '만든 때',
      'kv.modified': '바뀐 때', 'kv.size': '크기', 'kv.search': '검색',
      'inspector.source': '원본', 'inspector.prompt': '원본 요청', 'inspector.tags': '태그', 'inspector.note': '메모',
      'note.placeholder': '이 산출물에 대해 남길 말',
      'inspector.duplicates': ({ n }) => `같은 내용 ${num(n)}개`,
      'action.copyPath': '경로 복사', 'action.openSession': '세션 폴더 열기', 'action.copySession': '세션 id 복사',
      'action.reveal': 'Finder에서 보기',
      'action.markFinal': '최종본으로 표시', 'action.unmarkFinal': '최종본 해제',
      'action.favorite': '☆ 즐겨찾기', 'action.unfavorite': '★ 즐겨찾기 해제',
      'action.raw': '원문 보기', 'action.allowScripts': '스크립트 허용', 'action.blockScripts': '스크립트 차단',
      'panel.close': '정보 패널 닫기', 'panel.open': '정보 패널 열기', 'panel.aria': '정보 패널',
      'detail.created': ({ when }) => `만든 때 ${when}`,

      'home.search': '검색 결과 개요', 'home.filter': '필터 결과 개요', 'home.library': '라이브러리 개요',
      'home.count': ({ n }) => `${num(n)}개`, 'home.finals': ({ n }) => `최종본 ${num(n)}개`,
      'home.repos': ({ n }) => `저장소 ${num(n)}곳`,
      'home.activityFailed': '활동 기록을 불러오지 못했습니다.',
      'home.finalsTitle': '최종본', 'home.finalsEmpty': '최종본으로 표시한 산출물이 아직 없습니다.',
      'home.config': '구성',
      'home.block.activity': '활동 그래프',
      'home.block.sessions': '최근 작업', 'home.block.status': '수집 상태',
      'home.favoritesTitle': '즐겨찾기', 'home.favoritesEmpty': '즐겨찾기한 산출물이 아직 없습니다.',
      'home.statusFailed': '수집 상태를 불러오지 못했습니다.',
      'status.lastSweep': '마지막 수집', 'status.sweeps': '수집 횟수', 'status.watching': '감시 중',
      'status.artifacts': '산출물', 'status.origins': '출처',
      'status.logged': ({ n }) => `수집 기록의 오류 ${n}건`, 'status.clean': '최근 오류 없음',
      'home.moveUp': '위로', 'home.moveDown': '아래로', 'home.drag': '끌어서 순서 바꾸기',
      'home.blocksOff': '개요 블록을 모두 껐습니다.', 'home.blocksRestore': '기본 구성으로',
      'home.resetLayout': '기본 배치로',
      'keys.move': '이동', 'keys.fold': '접기 · 펼치기', 'keys.search': '검색',

      'chart.title': ({ period }) => `${period} · 에이전트가 쓴 산출물`,
      'chart.empty': ({ period }) => `${period} 에이전트가 쓴 산출물이 없습니다.`,
      'chart.hour': ({ day, hour }) => `${day} ${hour}시`,
      'chart.week': ({ day }) => `${day} 주`,
      'chart.axisHour': ({ hour }) => `${hour}시`,
      'chart.today': '오늘', 'chart.table': '표로 보기', 'chart.total': '합계',
      'chart.aria': ({ title }) => `${title}. 좌우 화살표로 칸을 옮깁니다`,
      'dist.only': ({ label }) => `${label}만 보기`, 'dist.none': '없음',
      'dist.kind': '종류', 'dist.agent': '에이전트', 'dist.workspace': '작업공간',
      'dist.workspaceTitle': ({ path }) => `${path} 에서 에이전트가 만든 것만 보기`,
      'dist.outside': ({ n }) => `라이브러리 밖 ${num(n)}개 (코드 · 기타)`,

      'reason.too-deep': '중첩 폴더 (스캐폴딩된 프로젝트)', 'reason.dotfile': '점으로 시작하는 파일 (.git 등)',
      'reason.excluded-dir': '제외 폴더 (tmp · attachments)', 'reason.not-artifacts-dir': '산출물 폴더 밖 (transcript 등)',
      'reason.unsafe-path': '안전하지 않은 경로', 'reason.symlink': '심볼릭 링크', 'reason.empty': '0바이트',
      'coverage.title': '수집 범위', 'coverage.sessions': '세션', 'coverage.collected': '수집', 'coverage.excluded': '제외',
      'coverage.sessionCounts': ({ total, withArtifacts, empty }) => `${num(total)}개 (산출물 있음 ${num(withArtifacts)}, 비어 있음 ${num(empty)})`,
      'coverage.count': ({ n }) => `${num(n)}개`,
      'coverage.reasons': '제외 이유', 'coverage.reasonLine': ({ n, reason }) => `${num(n)}개: ${reason}`,
      'coverage.largest': '제외된 가장 큰 묶음', 'coverage.groupLine': ({ n }) => `: ${num(n)}개`,
      'coverage.note': '에이전트가 산출물 폴더 안에 프로젝트를 통째로 만들면 그 파일들은 제외됩니다. 산출물 폴더 바로 아래 파일만 수집합니다.',

      'session.final': ({ n }) => `최종본 ${num(n)}`, 'session.subagents': ({ n }) => `서브에이전트 ${num(n)}`,
      'session.more': ({ n }) => `외 ${num(n)}개`,
      'activity.empty': '최근 활동이 없습니다.', 'activity.summary': ({ n }) => `최근 작업 ${num(n)}건`,
      'live.error': ({ when }) => `수집 오류 · ${when}`,
      'coverage.errors': '최근 수집 오류',
      'live.down': '연결 끊김', 'live.up': '실시간', 'live.collected': ({ when }) => `실시간 · ${when} 수집`,
      'theme.system': '시스템 설정', 'theme.light': '라이트', 'theme.dark': '다크',
      'theme.label': ({ current, next }) => `테마: ${current}. 누르면 ${next}`,
    },

    en: {
      'brand.home': 'Go to overview',
      'nodes.aria': 'Nodes', 'nodes.here': 'this machine', 'nodes.open': ({ name }) => `Open the catalog on ${name}`,
      'aria.modes': 'View',
      'mode.library': 'Library',
      'mode.activity': 'Activity',
      'aria.stats': 'Status',
      'sweep.idle': 'Collect now',
      'sweep.running': 'Collecting…',
      'aria.explorer': 'Explorer',
      'search.placeholder': 'Search names, content, tasks',
      'search.disabled': 'Activity is chronological, so search is off',
      'period.label': 'Period',
      'filters.label': 'Filters',
      'groupBy.label': 'Group',
      'groupBy.aria': 'Group the tree by',
      'tree.collapseAll': 'Collapse all',
      'aria.tree': 'Artifacts',
      'aria.results': 'Search results, most relevant first',
      'coverage.link': 'Coverage',
      'aria.resizer': 'Explorer width',
      'aria.content': 'Content',
      'importer.title': 'Import a folder',
      'importer.close': 'Close',
      'importer.confirm': 'Import this folder',
      'lang.aria': 'Language',

      'period.all': 'All', 'period.today': 'Today', 'period.7d': '7d', 'period.30d': '30d', 'period.90d': '90d',
      'periodTitle.all': 'All time · weekly', 'periodTitle.today': 'Today · hourly',
      'periodTitle.7d': 'Last 7 days', 'periodTitle.30d': 'Last 30 days', 'periodTitle.90d': 'Last 90 days',
      'periodName.all': 'so far', 'periodName.today': 'today',
      'periodName.7d': 'in the last 7 days', 'periodName.30d': 'in the last 30 days', 'periodName.90d': 'in the last 90 days',
      'unit.hour': 'Hour', 'unit.day': 'Date', 'unit.week': 'Week',
      'group.repo': 'Repository', 'group.provider': 'Agent', 'group.collector': 'App', 'group.date': 'Date', 'group.kind': 'Kind',

      'time.justNow': 'just now',
      'short.minutes': ({ n }) => `${n}m`, 'short.hours': ({ n }) => `${n}h`, 'short.days': ({ n }) => `${n}d`,

      'collector.import': 'Imported',
      'state.discovered': 'Discovered', 'state.final': 'Final',
      'filter.kind': 'Kind', 'filter.provider': 'Agent', 'filter.collector': 'App', 'filter.state': 'State',
      'filter.ext': 'Format', 'filter.tag': 'Tag', 'filter.workspace': 'Workspace', 'filter.favorite': 'Favorites',
      'subtitle.doc': 'Document title', 'subtitle.task': 'Task that made it',
      'bodyState.indexed': 'Full-text searchable', 'bodyState.skipped': 'Not full-text searchable',
      'bodyState.failed': 'Text extraction failed', 'bodyState.pending': 'Waiting to index', 'bodyState.none': 'Not indexed',
      'kind.text': 'Document', 'kind.code': 'Code', 'kind.bundle': 'Folder', 'kind.markup': 'Web page', 'kind.pdf': 'PDF',
      'kind.sheet': 'Spreadsheet', 'kind.office': 'Office document', 'kind.image': 'Image', 'kind.other': 'Other',
      'kind.memo': 'Agent notes',
      'kind.unclassified': 'Unclassified',

      'chip.only': ({ name }) => `Show only ${name}`,
      'badge.agents': ({ n }) => `${n} agents`,
      'badge.bundle': ({ n }) => `Folder · ${count(n, 'file', 'files')}`,
      'badge.missing': 'Missing', 'badge.final': 'Final', 'badge.favorite': 'Favorite',
      'badge.staleFinal': 'Changed since marked final',

      'filter.clearOne': 'Remove this filter',
      'facet.favoritesOnly': '★ Favorites only',
      'facet.outOfScopeTitle': 'Not in the library. Click to show only this kind',
      'facet.outOfScope': 'not in library',
      'facet.outsideTitle': 'Code, agent notes, and unknown formats are hidden from the library. Use the Kind filter to show them',
      'facet.outsideCount': ({ n }) => `${num(n)} not in library`,

      'stat.library': 'Library', 'stat.libraryTitle': 'Clear search and filters and show the whole library',
      'stat.final': 'Final', 'stat.finalTitle': 'Show only items marked final',
      'stat.recent': ({ n }) => `Last ${n} days`,
      'stat.recentTitle': ({ n }) => `Show only what agents touched in the last ${n} days (same as the period)`,
      'stat.active': ({ n }) => `Tasks in ${n}h`,
      'stat.activeTitle': ({ n }) => `Conversations that wrote files in the last ${n} hours. Click for Activity`,

      'where.worktree': ({ name }) => `git worktree: ${name}`,
      'tree.elsewhere': 'Outside repositories', 'tree.untitledTask': 'Untitled task', 'agent.unknown': 'Unknown agent',
      'date.today': 'Today', 'date.yesterday': 'Yesterday', 'date.week': 'Last 7 days', 'date.month': 'Last 30 days',
      'tree.noMatch': 'Nothing matches.', 'tree.empty': 'Nothing collected yet.',
      'tree.clear': 'Clear search and filters',
      'tree.touchedAt': ({ date }) => `Last touched by an agent ${date}`,
      'summary.count': ({ n }) => count(n, 'item', 'items'),
      'summary.partial': ({ n, total }) => `${num(n)} of ${num(total)}`,
      'summary.ranked': 'by relevance',
      'hint.like': 'Partial match', 'hint.fts': 'Full-text',

      'preview.missing': 'The original file is gone.', 'preview.missingNote': 'Its record, tags, and notes are kept.',
      'preview.bundleFiles': ({ n }) => count(n, 'file', 'files'),
      'action.backToBundle': '← Files',
      'preview.loading': 'Loading…', 'preview.unsupported': 'This format can’t be previewed.',
      'preview.loadFailed': 'Couldn’t load the file.',
      'sheet.empty': 'No sheets to show.',
      'change.created': 'Created', 'change.modified': 'Modified', 'change.moved': 'Moved',
      'change.missing': 'Removed', 'change.restored': 'Restored',
      'fresh.created': 'New', 'fresh.modified': 'Changed', 'fresh.moved': 'Moved', 'fresh.restored': 'Back',
      'changes.title': 'Just happened',
      'changes.empty': 'No changes yet. When an agent creates or edits a file, it shows up here right away.',
      'changes.outside': 'seen on disk',
      'version.title': ({ version }) => `Output Mesh version ${version}`,
      'changes.outsideTitle': 'Noticed on disk, not in an agent’s log. A person may have edited it, or an agent wrote it with a shell command',
      'changes.ownerTitle': ({ name }) => `Made by ${name}. This change was seen on disk, so who made it is unknown`,
      'changes.loading': 'Loading older changes…',
      'changes.end': 'No older changes',
      'changes.hidden': 'Hidden from the library:',
      'changes.hiddenKind': ({ kind, n }) => `${num(n)} ${kind.toLowerCase()}`,
      'collector.workspace': 'Repository docs',
      'sheet.untitled': ({ n }) => `Sheet ${n}`,
      'sheet.more': ({ n }) => `${count(n, 'more sheet', 'more sheets')} not previewed`,
      'sheet.truncated': ({ rows, cols }) => `Showing the beginning only (${num(rows)} rows × ${num(cols)} columns in total)`,
      'sheet.valuesOnly': 'Values only. Formatting, merged cells, and charts aren’t shown; formulas show their last calculated value.',

      'origins.title': ({ n }) => `Sources · ${count(n, 'session', 'sessions')}`,
      'origins.deliverable': 'Deliverable', 'untitled': '(untitled)',
      'origins.more': ({ n }) => `Show ${num(n)} more`,
      'tag.remove': ({ name }) => `Remove tag ${name}`, 'tag.prompt': 'Tag name', 'tag.add': '+ Add tag',

      'inspector.aria': 'Info', 'inspector.origin': 'Origin',
      'kv.agent': 'Agent', 'kv.task': 'Task', 'kv.workspace': 'Workspace', 'kv.created': 'Created',
      'kv.modified': 'Modified', 'kv.size': 'Size', 'kv.search': 'Search',
      'inspector.source': 'File', 'inspector.prompt': 'Original request', 'inspector.tags': 'Tags', 'inspector.note': 'Note',
      'note.placeholder': 'Notes about this artifact',
      'inspector.duplicates': ({ n }) => count(n, 'identical copy', 'identical copies'),
      'action.copyPath': 'Copy path', 'action.openSession': 'Open session folder', 'action.copySession': 'Copy session ID',
      'action.reveal': 'Show in Finder',
      'action.markFinal': 'Mark as final', 'action.unmarkFinal': 'Unmark final',
      'action.favorite': '☆ Favorite', 'action.unfavorite': '★ Unfavorite',
      'action.raw': 'View source', 'action.allowScripts': 'Allow scripts', 'action.blockScripts': 'Block scripts',
      'panel.close': 'Hide info panel', 'panel.open': 'Show info panel', 'panel.aria': 'Info panel',
      'detail.created': ({ when }) => `Created ${when}`,

      'home.search': 'Search overview', 'home.filter': 'Filtered overview', 'home.library': 'Library overview',
      'home.count': ({ n }) => count(n, 'item', 'items'), 'home.finals': ({ n }) => `${num(n)} final`,
      'home.repos': ({ n }) => count(n, 'repository', 'repositories'),
      'home.activityFailed': 'Couldn’t load activity.',
      'home.finalsTitle': 'Final', 'home.finalsEmpty': 'Nothing is marked final yet.',
      'home.config': 'Layout',
      'home.block.activity': 'Activity chart',
      'home.block.sessions': 'Recent tasks', 'home.block.status': 'Collection status',
      'home.favoritesTitle': 'Favorites', 'home.favoritesEmpty': 'Nothing is marked a favorite yet.',
      'home.statusFailed': 'Could not load the collection status.',
      'status.lastSweep': 'Last sweep', 'status.sweeps': 'Sweeps', 'status.watching': 'Watching',
      'status.artifacts': 'Artifacts', 'status.origins': 'Sources',
      'status.logged': ({ n }) => `${count(n, 'error', 'errors')} in the log`, 'status.clean': 'No recent errors',
      'home.moveUp': 'Move up', 'home.moveDown': 'Move down', 'home.drag': 'Drag to reorder',
      'home.blocksOff': 'All overview blocks are hidden.', 'home.blocksRestore': 'Restore defaults',
      'home.resetLayout': 'Reset layout',
      'keys.move': 'move', 'keys.fold': 'collapse · expand', 'keys.search': 'search',

      'chart.title': ({ period }) => `${period} · Artifacts written by agents`,
      'chart.empty': ({ period }) => `No artifacts written by agents ${period}.`,
      'chart.hour': ({ day, hour }) => `${day}, ${hour}:00`,
      'chart.week': ({ day }) => `Week of ${day}`,
      'chart.axisHour': ({ hour }) => `${hour}:00`,
      'chart.today': 'Today', 'chart.table': 'Show as table', 'chart.total': 'Total',
      'chart.aria': ({ title }) => `${title}. Use the left and right arrow keys to move between bars`,
      'dist.only': ({ label }) => `Show only ${label}`, 'dist.none': 'None',
      'dist.kind': 'Kind', 'dist.agent': 'Agent', 'dist.workspace': 'Workspace',
      'dist.workspaceTitle': ({ path }) => `Show only what agents made in ${path}`,
      'dist.outside': ({ n }) => `${num(n)} not in library (code, other)`,

      'reason.too-deep': 'Nested folder (scaffolded project)', 'reason.dotfile': 'Starts with a dot (.git and so on)',
      'reason.excluded-dir': 'Excluded folder (tmp, attachments)', 'reason.not-artifacts-dir': 'Outside the artifacts folder (transcripts and so on)',
      'reason.unsafe-path': 'Unsafe path', 'reason.symlink': 'Symbolic link', 'reason.empty': 'Zero bytes',
      'coverage.title': 'Coverage', 'coverage.sessions': 'Sessions', 'coverage.collected': 'Collected', 'coverage.excluded': 'Excluded',
      'coverage.sessionCounts': ({ total, withArtifacts, empty }) => `${num(total)} (${num(withArtifacts)} with artifacts, ${num(empty)} empty)`,
      'coverage.count': ({ n }) => num(n),
      'coverage.reasons': 'Why excluded', 'coverage.reasonLine': ({ n, reason }) => `${num(n)}: ${reason}`,
      'coverage.largest': 'Largest excluded groups', 'coverage.groupLine': ({ n }) => `: ${count(n, 'file', 'files')}`,
      'coverage.note': 'When an agent scaffolds a whole project inside the artifacts folder, those files are excluded. Only files directly under the artifacts folder are collected.',

      'session.final': ({ n }) => `${num(n)} final`, 'session.subagents': ({ n }) => count(n, 'subagent', 'subagents'),
      'session.more': ({ n }) => `+${num(n)} more`,
      'activity.empty': 'No recent activity.', 'activity.summary': ({ n }) => count(n, 'recent task', 'recent tasks'),
      'live.error': ({ when }) => `Collection error · ${when}`,
      'coverage.errors': 'Recent collection errors',
      'live.down': 'Disconnected', 'live.up': 'Live', 'live.collected': ({ when }) => `Live · collected ${when}`,
      'theme.system': 'System', 'theme.light': 'Light', 'theme.dark': 'Dark',
      'theme.label': ({ current, next }) => `Theme: ${current}. Click for ${next}`,
    },
  };

  /** 키가 한쪽 사전에 없으면 다른 언어를 보여주는 대신 키를 드러낸다 — 빠진 번역이 조용히 숨지 않게. */
  const t = (key, params = {}) => {
    const message = MESSAGES[lang][key];
    if (message === undefined) return key;
    return typeof message === 'function' ? message(params) : message;
  };

  /** data-i18n 은 글자를, data-i18n-attr="placeholder:key;title:key" 는 속성을 바꾼다. */
  const apply = (root = document) => {
    document.documentElement.lang = lang;
    for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const node of root.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of node.dataset.i18nAttr.split(';')) {
        const [attr, key] = pair.split(':');
        node.setAttribute(attr, t(key));
      }
    }
  };

  globalThis.i18n = {
    LANGS,
    MESSAGES,
    t,
    num,
    lang: () => lang,
    locale: () => LOCALE[lang],
    apply,
    set(next) {
      lang = LANGS.includes(next) ? next : lang;
      try {
        localStorage.setItem(KEY, JSON.stringify(lang));
      } catch {
        // 이번 화면에는 적용된다. 다음 방문에 브라우저 언어로 돌아갈 뿐이다.
      }
      apply();
      document.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
    },
  };

  apply();
})();
