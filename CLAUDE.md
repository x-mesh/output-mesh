# CLAUDE.md

## Project

output-mesh (Agent Output Catalog) — AI 에이전트 산출물을 읽기 전용으로 수집해 검색·미리보기·출처 추적을 제공하는 로컬 우선 카탈로그. bun HTTP 서버 + 브라우저 UI, 런타임 의존성 0개.

## Commands

```bash
bun test                          # 전체 테스트
make check                        # lint + test
bun bin/output-mesh.mjs serve           # 서버 (127.0.0.1:19843)
bun bin/output-mesh.mjs sweep           # 1회 수집
bun bin/output-mesh.mjs import <path>   # 수동 가져오기
bun bin/output-mesh.mjs coverage        # 수집 범위 — 무엇이 왜 제외됐는지
bun bin/output-mesh.mjs doctor          # 상태 점검
```

## Architecture

| 경로 | 역할 |
|---|---|
| `lib/paths.mjs` | 경로 상수, NFC 정규화 |
| `lib/scanner.mjs` | 순수 경로 분류. 파일시스템을 만지지 않는다 |
| `lib/aside-reader.mjs` | Aside `state.db` 읽기 전용 |
| `lib/cursor-reader.mjs` | Cursor `state.vscdb` 읽기 전용. composer 가 고친 파일 |
| `lib/session-logs.mjs` | Codex rollout · Claude Code transcript 에서 쓴 경로 수확 |
| `lib/collector.mjs` | 스윕 · 보강 · 색인 |
| `lib/store.mjs` + `schema.sql` | SQLite 인덱스 |
| `lib/search.mjs` | trigram / LIKE 분기, 라이브러리·활동 질의 |
| `lib/extract.mjs` | 종류별 본문·문서 제목 추출 |
| `lib/describe.mjs` | 목록 행의 부제·위치 규칙. 순수 함수 |
| `lib/watcher.mjs` | 주기 스윕 + fs.watch 가속, 수집 이벤트 발행 |
| `lib/coverage.mjs` | 수집 범위 조사. 스윕 경로에서 부르지 않는다 |
| `lib/workspace-docs.mjs` | 에이전트가 일한 저장소와 그 안의 문서 판정 |
| `lib/worktrees.mjs` | 작업공간이 어느 저장소의 것인가. `.git` 포인터만 읽는다 |
| `lib/server.mjs` | HTTP API + 아티팩트 서빙 |
| `public/` | 바닐라 ESM UI |
| `public/vendor/` | 핀 고정한 브라우저 라이브러리 (marked.js, gridstack) |

### Key design decisions

**파일시스템은 지연 시간, `state.db`는 권위.** 두 신호의 실패 모드가 서로를 상쇄한다. 디스크에는 273개 파일이 있는데 `files_changed`에는 86개 항목뿐이고, 디스크 세션 디렉터리 73개에 대해 DB `sessions`는 71행이다. DB만 보면 놓치고, 파일시스템만 보면 13배 과수집한다.

**수집 범위는 `artifacts/` depth 1.** 한 세션이 `artifacts/` 안에 npm 프로젝트를 통째로 스캐폴딩해서 273개 중 264개를 차지한다. 디렉터리 이름 비교 하나로 syscall 이전에 거부한다. Aside 가 변경으로 기록한 파일에 대해서는 이 규칙과 Aside 자신의 산출물 플래그(`artifact.sizeBytes`)가 같은 집합을 고르고(32개), 어긋나면 V3 테스트가 잡는다. Aside 가 기록하지 않은 파일(이미지 생성 도구나 셸이 `artifacts/` 에 바로 쓴 것, 실측 5개)은 플래그로 판정할 수 없어 비교에서 빼고, 표시 뒤 지워지거나 이름이 바뀐 파일도 뺀다 — 처음에는 20/20 완전 일치였지만 그 둘이 생기면서 완전 일치는 더 이상 계약이 아니다.

**출처는 파일당 여럿이다.** 수집 경로 700개 중 148개(21%)를 세션 2개 이상이, 37개를 공급자 2곳이 건드렸고 한 파일 최대 17세션이다. `artifact_origins` 가 `(artifact_id, collector, session_ref)` 를 키로 이를 담는다. 1:1 이던 `provenance` 는 **읽기 전용 잔재**로 남아 있다 — 마이그레이션 입력이자 롤백 경로이고, 아무도 쓰지 않는다.

- **turn 은 키가 아니다.** Aside 는 한 세션이 같은 파일을 최대 4턴에 걸쳐 고치지만, 한 파일을 두 Aside 세션이 건드린 적은 0번이다. turn 을 키에 넣으면 행이 부풀고 활동 보기의 파일 수가 턴 수가 된다.
- **`session_ref` 는 NULL 이 아니라 `''`.** SQLite 는 PK 의 NULL 을 서로 다른 값으로 보아 가져오기 출처가 스윕마다 새 행으로 쌓인다.
- **대표 출처는 저장하지 않고 계산한다.** `is_deliverable DESC, occurred_at DESC, collector, session_ref` 순. `rowid` 를 쓰지 않는다 — `VACUUM` 이 재번호해 대표가 이유 없이 바뀐다.
- **뷰로 계산하지 않는다.** window 함수 뷰는 매 질의 출처 테이블 전체를 구체화해 공급자 필터가 0.11ms → 2.40ms 가 됐다. `search()` 는 보일 행을 먼저 자르고 그 행에만 대표·칩을 장식한다.
- **출처 조건은 `EXISTS`, 출처 패싯은 `COUNT(DISTINCT a.id)`.** 조인하면 목록 건수와 사이드바가 출처 수만큼 부푼다.
- **`group_concat(DISTINCT x, sep)` 은 bun:sqlite 에서 실패한다**(`DISTINCT aggregates must have exactly one argument`). 순서도 미정의라 칩이 흔들린다. 정렬한 중첩 SELECT 를 넘긴다.
- **활동 보기는 세션 자신의 시각(`occurred_at`)으로 세운다.** 파일 수정 시각을 쓰면 다른 세션이 오늘 고친 파일 때문에 몇 주 전 세션이 '방금'으로 올라온다.
- **섞인 출처(chimera)는 키가 틀렸을 때만 생긴다.** 한 키 안의 기록자는 항상 같은 소스라 컬럼별 COALESCE 가 출처를 섞을 수 없다. 1:1 시절 37행이 `collector` 는 첫 기록자, 나머지는 마지막 기록자로 갈려 있었다. `counts().chimeraOrigins` 가 재발을 감시한다.

**세션 로그 배치는 세션까지 키로 잡는다.** `sweepSessionLogs` 의 `discovered` 는 `(sessionRef, path)` 가 키다. 경로만으로 잡으면 mtime 순으로 읽는 배치 안에서 같은 파일을 건드린 세션들이 가장 새 것만 남고 조용히 버려진다 — 1:N 스키마로도 되살릴 수 없는 손실이다. 전수 재파싱 뒤 `counts().multiOrigin` 이 0 이면 이게 다시 깨진 것이다.

**자라는 로그는 이어 읽는다.** mtime 커서는 "어느 로그가 바뀌었나"만 답한다. 에이전트가 도는 동안 그 로그는 몇 초마다 자라는데, 통째로 다시 읽으면 31MB 대화 로그 하나에 수집마다 수십 MB 를 할당해 서버가 30초에 66MB 씩 불었다(3.9GB 까지). 워처가 로그마다 읽은 바이트 위치와 앞부분에서 알아낸 세션 정보(`newLogTail`)를 들고 있어서 새로 붙은 줄만 읽는다. 끝에 줄바꿈 없이 남은 조각은 쓰는 중일 수 있어 JSON 으로 완성됐을 때만 받는다. 파일이 줄거나 inode 가 바뀌면 처음부터 읽는다. JSON.parse 전에 필요한 줄(세션 정보·사람 발화·쓰기)만 문자열로 거른다 — 첫 실행 4.2GB 파싱이 7.8초 → 4.3초, 최대 메모리 2.9GB → 1.1GB 가 됐고 결과는 해시까지 같다.

**Cursor 는 composer 한 자리에서만 읽는다.** Cursor 는 로그 파일을 남기지 않는다. 고친 파일이 남는 곳을 셋 다 열어 봤고 쓸 수 있는 자리는 `state.vscdb` 의 `composerData:<uuid>` 하나였다(실측 48행 중 파일 기록 10건, 경로 79개). `originalFileStates` 가 고친 파일, `newlyCreatedFiles` 가 새로 만든 파일이고 `createdAt`·`lastUpdatedAt` 이 시각이다.

- **버린 두 자리.** 세션별 `~/.cursor/chats/<작업공간>/<세션>/store.db` 는 558개를 다 열어도 도구가 전부 읽기였다(Read 1150 · Grep 676 · Shell 290). 전역 `agentKv:blob:<sha256>` 에는 쓰기가 있지만(ApplyPatch 69 · Write 2) 키가 내용 해시라 어느 세션의 언제인지를 붙일 수 없다.
- **커서는 밀리초다.** `lastUpdatedAt` 을 그대로 쓴다. 초로 줄이면 같은 밀리초의 대화가 가려진다.
- **작업공간은 되짚어 채운다.** Cursor 가 cwd 를 주지 않아서 파일이 놓인 곳에서 `resolveWorkspace` 로 저장소를 찾는다. 추론이지만 이래야 위치가 실제 경로가 아니라 저장소 이름으로 보이고 worktree 도 본 저장소로 모인다.
- **색은 중립 회색이다.** 검증한 세 에이전트 색 사이에 넷째를 끼우면 적색맹 인접 ΔE 가 좁아진다.

**Codex·Claude Code 는 산출물이 아니라 출처를 준다.** 둘 다 산출물 레코드가 없지만 세션 로그에 쓴 경로가 남는다 — Codex 는 `apply_patch` 본문의 `*** Add/Update File:` 마커(1,236개 중 321개), Claude Code 는 `tool_use` 블록의 `file_path`. 그 경로의 파일은 이미 저장소 안에 있으므로 옮기지 않고 출처만 붙인다. Aside 가 주지 못하는 `workspace` 가 여기서 채워진다. 자동 발견분은 산출물 플래그가 없으므로 절대 `final` 로 올리지 않는다.

**작업공간은 본 저장소로 접어서 센다.** 출처의 `workspace` 는 세션이 돈 폴더(cwd) 그대로 둔다 — 사실이다. 그런데 작업공간 44곳 중 18곳이 git worktree(`~/.gk/worktree/…`, `<저장소>/.claude/worktrees/…`)라 저장소 하나가 트리와 분포에서 네 군데로 갈라졌다. `workspace_roots(workspace, top, root)` 가 그 대응을 담는다. 재생성 가능한 새 테이블이라 `schema.sql` 에 바로 둔다.

- **`top` 과 `root` 는 다른 질문에 답한다.** 파일이 그 체크아웃 안에 있는가는 `top`(`.git` 이 있는 가장 가까운 상위 폴더)으로, 어느 저장소인가는 `root`(worktree 면 본 저장소)로 본다. worktree 의 파일 경로는 본 저장소 아래에 있지 않아서 `root` 로 포함 판정을 하면 전부 "저장소 밖"이 된다.
- **비교는 `rootOf(alias)` 하나로.** 패싯 · 필터 · 활동 · 그래프가 같은 식을 쓴다. 아직 찾지 않은 작업공간은 자기 자신이라 조용히 사라지지 않는다.
- **홈과 그 위의 `.git` 으로는 올라가지 않는다.** 홈에 dotfiles 저장소를 둔 머신에서는 저장소가 아닌 모든 폴더가 홈 하나로 접힌다.
- **지워진 worktree 의 대응은 덮어쓰지 않는다.** 폴더가 없으면 다시 풀 수 없는데, 자기 자신으로 덮어쓰면 재시작마다 다시 갈라진다.
- **`describe.mjs` 는 여전히 순수 함수다.** 디스크를 읽는 건 `worktrees.mjs` 이고, describe 는 `{ top, root }` 를 받아 계산만 한다.

**개요는 위젯 격자다. 격자 엔진만 빌리고 생김새는 빌리지 않는다.** 자리와 크기는 `gridstack`(13.3.0, `public/vendor/`)이 맡고, 고른 배치는 `aoc.home.layout` 에 남는다. `PRODUCT.md` 의 안티레퍼런스는 "둥근 카드 격자"라는 **생김새**라서, 쉴 때 카드 테두리·그림자·애니메이션을 그리지 않으면 어긋나지 않는다. 경계는 끄는 동안에만 보인다.

- **그리드를 다시 세우는 건 블록을 켜고 끌 때뿐이다.** 수집 알림이 30초마다 `renderHome` 을 부르는데 그때마다 `GridStack.init` 을 다시 하면 화면이 깜빡이고 끌던 손이 끊긴다. 틀은 두고 `fillBlocks` 가 `.block-body` 안만 갈아 끼운다.
- **`handle: '.drag-handle'`.** 위젯 전체를 끌 수 있게 두면 피드 글자를 긁어 고를 수 없다.
- **`alwaysShowResizeHandle: true`.** 기본값은 hover 때만 보인다. 작은 `구성` 링크 하나로는 아무도 못 찾았고, 같은 이유로 손잡이도 늘 보여야 한다.
- **위젯이 쓰는 것만 받는다.** 최근 작업(`/api/activity`)과 수집 상태(`/api/status`)는 그 위젯이 켜져 있을 때만 부른다. 개요는 수집 알림마다 다시 그려져서, 안 보이는 위젯의 요청이 30초마다 쌓인다.
- **키보드는 구성 패널이 맡는다.** 끌기와 크기 조절은 마우스만 닿으므로, 켜고 끄기 · 한 칸 이동 · 기본 배치 복원을 패널에 둔다. `PRODUCT.md` 의 "키보드로 끝까지 간다"를 이 경로가 지킨다.

**목적이 둘이라 화면도 둘이다.** 큐레이션된 산출물을 찾는 일과 에이전트가 무엇을 했는지 보는 일은 같은 목록으로 섞이지 않는다.

- **라이브러리**(기본) — 문서·이미지·산출물만. 코드를 빼서 100개. `final` 을 먼저 보여준다. 종류를 직접 고르면 그 선택이 이긴다.
- **활동** — 전부를 세션 타임라인으로. 단위가 파일이 아니라 작업이라 `(collector, session_ref)` 로 묶고 최신순으로 세운다. 감시용이라 검색을 쓰지 않는다.

**코드 판정은 확장자만으로 부족하다.** `.tape`·`.pbxproj` 같은 스크립트와 `Makefile`·`.zshrc` 처럼 확장자가 없는 설정이 문서로 새면 산출물이 묻힌다. `kindOf(ext, fileName)` 이 파일명까지 본다 — 점으로 시작하면 설정, 확장자가 없으면 문서가 아니다.

**에이전트 메모는 숨기되 버리지 않는다.** Claude Code 의 프로젝트 memory(`~/.claude/projects/*/memory/`)는 에이전트가 자기용으로 적는 메모다. 실측 18개가 라이브러리와 "방금 일어난 일" 맨 위에 섞여 산출물을 가렸다. 수집에서 빼면 나중에 찾을 수 없으므로 종류 `memo` 로 분류해 코드처럼 라이브러리에서만 숨긴다. 이 종류는 `listKindOf(ext, fileName, absPath)` 만 낸다 — `kindOf` 는 추출과 미리보기를 구동하고 메모도 문서로 읽혀야 하므로 경로를 보지 않는다. 폴더 이름 `memory` 만으로 가르지 않는다: 저장소의 `docs/memory/` 는 진짜 문서다. 반대로 Claude Code 의 세션 임시 폴더(`/private/tmp/claude-*/`)는 세션이 끝나면 버려지는 자리라 세션 로그 수집에서 뺀다(`isIndexablePath`). 임시 폴더 전체를 거르지는 않는다.

**분류는 쓸 때 굳는다.** `artifacts.kind` 가 그 결과를 담는다. 읽을 때 분류하면 호출부마다 인자를 빠뜨릴 수 있고(실제로 `server.mjs` 세 곳이 갈라져 있었다) `missing_at` 으로 좁힌 id 목록에 이음매가 생긴다. 컬럼이면 `a.kind` 하나라 갈라질 수가 없다. 대신 캐시이므로 **무효화 키가 필요하다** — `kindOf` 를 고치면 그 바로 위의 `KIND_RULES_VERSION` 을 올린다. 안 올리면 분류 수정이 기존 행에 아무 효과도 내지 않는다.

**라이브러리 제외는 `IS NOT` 으로 쓴다.** `a.kind <> 'code'` 는 `kind` 가 NULL 인 행을 **에러 없이 버린다.** `IS NOT` 은 NULL 을 남긴다 — 분류가 비어도 조용히 사라지는 것보다 보이는 쪽이 낫다. `output-mesh doctor` 의 `kindNull` 이 그 상태를 드러낸다.

**패싯은 자기 차원만 빼고 센다.** 각 패싯 그룹은 활성 필터를 전부 적용하되 자기 차원만 제외한다. 모든 필터를 모든 패싯에 적용하면 `형식: md` 를 고르는 순간 형식 그룹이 한 줄로 접혀 갈아탈 수 없다. 그리고 라이브러리 제외 규칙 자체가 종류 필터이므로, "종류 차원을 뺀다"가 곧 "라이브러리 규칙도 뺀다"가 되어 범위 밖인 `코드` 도 전역 건수로 남는다 — 한 번의 클릭 거리에 두기 위해서다.

**셸로 쓴 문서는 저장소를 감시해서 잡는다.** Claude Code 로그에는 `Write`·`Edit` 경로만 남아 셸(`cat >`, `sed -i`, 스크립트)로 고친 README·CHANGELOG 는 영영 안 잡혔다. 에이전트 출처의 `workspace` 중 홈 아래이고 프로젝트 표지가 있는 곳(중첩은 바깥 하나)을 처음 한 번 걸어 최근 `WORKSPACE_BACKFILL_DAYS` 일 문서를 조용히 넣고, 그 뒤로는 fs.watch 가 바뀐 문서만 알린다 — 저장소 21곳의 파일 15만 개를 30초마다 걷지 않는다.

- **문서만 받는다.** `kindOf` 가 라이브러리 숨김 종류가 아닌 것. 코드까지 받으면 저장소를 통째로 옮겨 적은 카탈로그가 된다.
- **이미 아는 파일에는 출처를 더하지 않는다.** 바뀐 내용은 다시 확인이 잡는다. 더하면 파일 mtime 이 세션 시각보다 늦어서 대표 출처가 에이전트에서 `workspace` 로 뒤집힌다.
- **세션이 없는 출처는 에이전트 활동이 아니다.** `session_ref = ''` 인 출처(작업공간·가져오기)는 사건 `source` 가 `disk` 이고, 타임라인과 24시간 작업 수에서 빠진다.

**피드가 숨긴 것은 건수로 남긴다.** "방금 일어난 일"은 라이브러리 규칙을 따라 코드·기타를 뺀다. 빼기만 하면 코드를 고쳤는데 피드가 조용해 수집이 멈춘 것처럼 보이므로, `recentChanges` 가 보인 가장 오래된 변경 이후의 숨긴 건수를 `hidden` 으로 같이 준다.

**활동은 SSE 로 살아 있다.** 수집이 한 바퀴 돌 때마다 `/api/events` 가 알리고, 워처는 Aside 뿐 아니라 Codex·Claude 로그 루트도 감시한다. 활동 보기는 바로 다시 그리고, 라이브러리는 보던 자리를 흔들지 않도록 건수만 갱신한다.

`KIND.CODE` 는 추출·미리보기에서 `KIND.TEXT` 와 동일하게 처리된다 — 갈라 보는 건 목록에서뿐이다.

**세션 제목은 첫 사람 발화다.** 로그의 첫 user 메시지는 대개 지침 덤프(AGENTS.md, system-reminder, teammate-message, Codex 의 `<environment_context>`, 스킬 호출 문구)라 건너뛴다. 이게 틀리면 활동 보기가 읽히지 않는다. 제목은 첫 줄이 아니라 쓸 만한 첫 줄이고(`titleFromPrompt`), 붙여넣은 경로로 시작하면 파일 이름만 남긴다. 출처는 새 제목이 없을 때 옛 제목을 지키므로(`COALESCE`) 이미 저장된 잡음은 활동 보기가 읽을 때 가린다(`sessionTitleOf`).

**산출물 폴더 아래 디렉터리는 한 줄로 접는다.** 에이전트가 프로젝트를 통째로 만들면 수백 개 파일이 아니라 번들 한 행이 된다. 정체성은 내용물 목록의 해시이고(파일을 읽지 않는다), 내용물 경로는 검색 본문으로 남아서 번들 **안의** 파일명으로도 찾을 수 있다. `.git`·`node_modules` 는 목록에서 뺀다.

**DB는 집합을 넓힐 수 있고 파일시스템은 못 넓힌다.** 플래그가 붙은 경로는 깊이와 무관하게 받아들여서 Aside의 레이아웃 변화를 코드 수정 없이 따라간다. 반대 방향은 막혀 있다.

**재생성 가능한가로 스키마를 갈랐다.** 경로·해시·출처는 디스크에서 다시 만들 수 있으니 최소한만 둔다. 태그·메모·즐겨찾기·final 표시는 재생성 불가라 지금 보호한다 — 그래서 행을 `DELETE` 하지 않고 `missing_at`만 세우고, 이름 변경은 inode로 추적한다.

**목록 행은 "무엇인가"와 "어디서"를 따로 답한다.** 라이브러리의 44%가 이름이 겹친다(SKILL.md 19개). 최초 질문은 그 세션이 하던 일이라 저장소 파일에는 "계속"·"진행해"가 붙는다. 그래서 부제는 문서 자체의 제목이 먼저고, 쓸 만하지 않을 때만 만든 작업(루트 스레드의 가장 이른 제목)으로 내려간다. 위치는 파일을 담은 작업공간 기준이고, 밖이면 실제 경로를 보인다.

**파생 캐시에는 버전 키가 붙는다.** `KIND_RULES_VERSION`·`SESSION_LOG_PARSER_VERSION`·`EXTRACT_RULES_VERSION` — 규칙을 고치고 키를 안 올리면 기존 행이 옛 결과로 남는다. 추출 버전이 바뀌면 `search_docs`를 `pending`으로 돌리고, 워처가 수집기와 무관하게 `indexPending`을 부른다. Aside 리더에 묶여 있으면 Aside 없는 머신에서 영영 다시 뽑히지 않는다. 번들 본문(구성 파일 목록)은 `ingestBundle`만 만든다.

**마이그레이션 도구가 없다.** 인덱스는 재생성 가능하다. 스키마는 `CREATE TABLE IF NOT EXISTS` 멱등 배치.

단서 하나: 태그·메모·즐겨찾기·final 은 재생성할 수 없어서 **다시 만들 수 없는 카탈로그가 있다.** `CREATE TABLE IF NOT EXISTS` 는 기존 테이블에 컬럼을 덧붙이지 못하므로, 컬럼을 늘릴 때는 `PRAGMA table_info` 로 확인하고 멱등 `ALTER TABLE` + 백필을 한다(`store.#ensureKind`). 백필은 "방금 ALTER 했는가"가 아니라 **`kind IS NULL` 을 기준으로** 한다 — 그래야 예전 빌드가 넣은 행도 다음 실행이 스스로 고친다. 새 컬럼에 대한 `CREATE INDEX` 를 `schema.sql` 에 넣으면 안 된다. 기존 DB 에서는 스키마 배치가 ALTER 보다 먼저 돌아 `no such column` 으로 터진다.

## Conventions

- 런타임 의존성을 추가하지 않는다. `bun:sqlite`, `node:*`, macOS 기본 도구만.
- 브라우저 라이브러리는 `public/vendor/`에 버전을 고정해 넣는다 (x-dashboard 관례). 패키지 매니저를 끌어오지 않는다.
- 렌더한 마크다운도 에이전트가 만든 내용이다. `sandbox=""` iframe 안에서만 그리고, `srcdoc`은 서버 CSP 헤더가 덮지 못하므로 문서 안에 meta CSP를 넣는다.
- 경로 비교·조회는 `path_key`(NFC)로만, 파일 읽기는 `abs_path`(원본 바이트)로만. macOS `readdir`은 NFD를 준다.
- `state.db`는 `{ readonly: true }`로만 연다. 복사해서 읽지 않는다 — WAL을 잃는다.
- `json_each(files_changed)`에는 항상 `WHERE json_valid(...)`. 없으면 깨진 행 하나가 스윕을 조용히 자른다.
- 수집 커서는 `session_turns.id`(rowid). `started_at`은 초 단위라 같은 초를 가린다.
- 추출 실패는 `skipped`(불가)와 `failed`(시도했으나 실패)로 구분한다. 조용한 빈 본문 금지.
- 긴 수집 루프는 `COLLECT_YIELD_MS` 마다 `setTimeout(0)` 으로 양보한다. 로그 파싱이 동기라 양보하지 않으면 Ctrl-C 가 안 먹히고, 서버가 뜬 뒤에는 주기 수집 동안 HTTP 요청이 멈춘다. Bun 의 `setImmediate` 로는 밀린 타이머가 차례를 얻지 못했다.
- 수집 진행 보고(`onProgress`)는 `serve` 의 첫 수집에만 단다. 주기 수집과 `/api/sweep` 은 조용해야 한다.
- 변경 기록(`artifact_events`)은 `ingestFile` 과 `markMissing` 안에서만 남긴다. 내용이 그대로인 `touched` 는 남기지 않는다. 빈 카탈로그의 첫 수집은 `quietEvents` 로 조용히 한다.
- 클라이언트가 준 문자열이 파일시스템에 닿는 경로를 만들지 않는다. 서빙 경로는 DB 조회로만.
- 목록과 사이드바는 같은 파라미터를 쓴다. `filtersFrom(url)`(서버)과 `searchParams()`(클라이언트)가 한 곳이다. 갈라지면 사이드바가 목록에 없는 것을 광고한다.
- 정적 파일은 `cache-control: no-store` 로 보낸다. 검증자 없이 캐시되면 편집한 UI 가 새로고침에도 안 바뀌어, 자기 수정을 눈으로 확인할 수 없다.
- 화면 문구는 `public/i18n.js` 사전에만 둔다(영어·한국어). `app.js` 에 한국어 문자열을 쓰면 `test/i18n.test.mjs` 가 잡는다. 서버는 값만 보내고 이름표는 화면이 붙인다.
- 상수는 `lib/paths.mjs`에. 매직 넘버 금지.
- 이름은 `output-mesh`(패키지·실행 명령)지만 데이터 폴더 `CATALOG_DIR`(`AgentOutputCatalog`)와 브라우저 저장 키(`aoc.*`)는 옛 이름 그대로 둔다. 바꾸면 이미 쌓인 태그·메모·최종본 표시와 보던 자리를 잃는다.
- 주석은 "왜"만. 코드가 표현하는 것을 반복하지 않는다.

## Key Files

| 파일 | 왜 중요한가 |
|---|---|
| `lib/scanner.mjs` | 오염 방지 술어. 여기가 느슨해지면 라이브러리가 즉시 망가진다 |
| `lib/aside-reader.mjs` | 외부 앱 DB와의 계약. Aside가 바뀌면 여기가 먼저 깨진다 |
| `test/aside-contract.test.mjs` | 그 계약이 깨졌는지 알아채는 유일한 검사 |
| `lib/schema.sql` | FTS5 외부 콘텐츠 + 트리거 3종 |

## Environment

macOS. bun ≥ 1.3. 시스템 `unzip`(xlsx 본문 추출). Aside가 없으면 관련 테스트는 skip 된다.

`~/Downloads`·`~/Desktop`·`~/Documents`를 가져오려면 bun 바이너리에 전체 디스크 접근 권한이 한 번 필요하다.

## Out of Scope

아래는 의도적으로 약화하면 안 되는 불변식이다.

- 원본 폴더와 에이전트 데이터에 **쓰지 않는다**. `state.db`는 readonly 연결로만 연다.
- 아티팩트 파일을 복사하지 않는다. 인덱스는 원본을 참조만 한다.
- 아티팩트 HTML은 `connect-src 'none'` CSP와 `allow-same-origin` 없는 iframe에서만 렌더한다. 스크립트를 허용해도 네트워크는 열리지 않는다.
- 서버는 `127.0.0.1`에만 바인딩한다.
- 사용자 소유 데이터(태그·메모·즐겨찾기·final)는 스윕이 덮어쓰지 않는다.
- 무엇이 왜 제외됐는지는 항상 확인 가능해야 한다 (PRD 7.1). `coverage`가 그 답이다.
- 모든 아티팩트는 출처를 하나 이상 가진다. `counts().artifactsWithoutOrigin` 은 항상 0 이어야 한다 — 출처가 없는 아티팩트는 칩도 활동 보기도 없이 조용히 사라진다.
- 세션 로그에서 찾은 경로는 **존재하는 파일만** 색인한다. 없는 경로를 넣으면 "원본 없음"이 처음부터 붙은 유령 행만 는다.
- 세션 로그 수집기는 mtime 커서로 증분 처리한다. Codex 로그가 3.6GB라 전수 파싱은 첫 실행에만 한다.
- 내용이 그대로여도(`touched`) 출처를 기록한다. 1:N 에서는 이게 덮어쓰기가 아니라 **다른 세션의 삽입**이다 — 다중 세션 파일 대부분이 이 경로로만 들어온다.
- 출처 한 줄의 산출물 표시(`is_deliverable`)는 `MAX` 로 접는다. Aside 의 표시는 긍정 주장이고 다른 출처는 정보가 없을 뿐이라 취소하지 않는다.
- 분류는 출처에서 파생된 **공급자 칩**이다. `tags` 는 사용자가 손으로 다는 용도로만 둔다 — 재생성 가능한 공급자 정보를 재생성 불가 테이블에 앉히면 수집 버그를 고쳐도 낡은 태그가 영원히 남는다.
