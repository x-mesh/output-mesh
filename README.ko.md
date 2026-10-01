<p align="center">
  🇰🇷 한국어 | 🇺🇸 <a href="./README.md">English</a>
</p>

<h1 align="center">output-mesh</h1>

<p align="center">
  AI 에이전트가 만든 파일을 한곳에 모으는 로컬 카탈로그.<br />
  산출물을 몇 초 만에 찾고, 안전하게 미리 보고, 어느 에이전트가 어느 세션에서 만들었는지 확인한다.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/bun-%3E%3D1.3-black" alt="Bun >= 1.3" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="Platform: macOS" />
  <img src="https://img.shields.io/badge/runtime%20deps-0-brightgreen" alt="런타임 의존성 0개" />
</p>

## 왜 필요한가

에이전트는 보고서, PRD, 스프레드시트, HTML 시안, 이미지를 세션 폴더와 저장소 곳곳에 쓴다. 일주일만 지나도 무슨 작업이었는지는 기억나지만 파일 이름과 위치는 기억나지 않는다. 게다가 `README.md`, `SKILL.md`처럼 이름이 같은 파일이 많다.

output-mesh는 그 자리들을 **바꾸지 않고 읽기만 해서** 라이브러리 하나로 모은다. 파일 이름, 본문, 그 파일을 만든 작업으로 찾을 수 있고, 파일마다 만든 에이전트와 세션, 저장소가 붙는다.

<p align="center">
  <img src="./assets/demo.gif" alt="output-mesh: 라이브러리를 둘러보고, 산출물과 그것을 만든 에이전트·세션을 확인하고, 작업으로 검색하고, 새 파일이 바로 나타나는 모습" width="900" />
</p>

<p align="center"><sub>실제 로그가 아니라 따로 만든 예시 데이터로 녹화했다.</sub></p>

## 시작하기

macOS와 [Bun](https://bun.sh) 1.3 이상이 필요하다. output-mesh는 따로 설치하지 않아도 된다.

```bash
bunx output-mesh
```

그다음 http://127.0.0.1:19843 을 연다.

Bun이 내려받은 패키지를 보관하므로 다음부터는 바로 시작한다. 새 릴리스를 받으려면 `bunx output-mesh@latest`를, `main`의 최신 커밋을 받으려면 `bunx github:x-mesh/output-mesh`를 실행한다.

처음 실행하면 에이전트 로그를 모두 한 번 읽으면서 진행 상황을 보여 준다. 다음부터는 바뀐 부분만 읽는다.

화면은 영어와 한국어를 지원하고 브라우저 언어를 따른다. 상단 바의 `KO` / `EN`으로 바꿀 수 있다. 서버 시작 화면과 명령 도움말은 영어다.

output-mesh는 Bun에 들어 있는 SQLite를 쓰기 때문에 `npx`로는 실행되지 않는다. 저장소를 받아서 실행하려면 다음과 같이 한다.

```bash
git clone https://github.com/x-mesh/output-mesh.git
cd output-mesh
bun bin/output-mesh.mjs
```

### 서비스로 실행하기

로그인할 때마다 저절로 켜지게 하려면 서비스로 설치한다.

```bash
bun install -g output-mesh
output-mesh install
```

`install`은 macOS에서는 LaunchAgent를, 리눅스에서는 systemd 사용자 유닛을 등록한다. 서비스는 `output-mesh start`, `stop`, `restart`, `status`로 다루고, `output-mesh uninstall`로 지운다.

`bunx`로 받은 사본에서는 `install`이 거부된다. 그 경로는 임시 폴더라 재부팅하면 사라지기 때문이다. 저장소를 받아 둔 곳에서 `bun bin/output-mesh.mjs install`을 실행해도 된다.

## 무엇을 모으나

| 출처 | 위치 | 방법 |
|---|---|---|
| Aside | `~/.aside/u/<계정>/sessions/<날짜>_<id>/artifacts/` | 폴더를 감시하고, Aside의 `state.db`를 읽기 전용으로 열어 정보를 보탠다 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 세션 로그의 `apply_patch` 표시에 적힌 경로 |
| Claude Code | `~/.claude/projects/**/*.jsonl`, `/private/tmp/claude-<uid>/` 의 세션 작업 폴더 | `Write`, `Edit` 도구 호출의 `file_path`, 작업 폴더의 이미지 |
| Claude Desktop | `~/Library/Application Support/Claude/Cache/Cache_Data/` | 로컬 캐시에 남은 아티팩트 HTML, 채팅이 쓴 파일, 채팅 위젯 |
| Gemini Antigravity | `~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/brain/` | 로컬 세션 산출물과 쓰기 도구가 기록한 파일 경로 |
| Cursor | `~/Library/Application Support/Cursor/.../state.vscdb` | composer가 고치거나 새로 만든 파일. 데이터베이스는 읽기 전용으로 연다 |
| 내 저장소 | 위 에이전트들이 작업한 저장소와 그 저장소의 git worktree | 최근 7일 안에 바뀐 문서. 그 뒤로는 폴더를 감시해서 새로 생기거나 바뀐 문서를 찾는다 |
| 그 밖의 파일 | 직접 고른 폴더나 파일 | `output-mesh import <경로>` |

Codex와 Claude Code는 산출물을 따로 모아 두지 않는다. 대신 로그에 어느 경로에 썼는지가 남는다. output-mesh는 아직 저장소에 있는 그 파일에 에이전트와 세션을 붙이고, 파일은 그 자리에 둔다.

라이브러리에는 문서, 웹 페이지, 이미지, 스프레드시트, 프로젝트 폴더가 보인다. 소스 코드, 에이전트 메모, 기타 형식도 모으지만 라이브러리에서는 숨긴다. 에이전트 메모는 Claude Code가 `~/.claude/projects/*/memory/`에 적어 두는 메모 파일이다. 숨긴 종류를 보려면 종류 필터에서 고른다. "최근 변경"도 같은 종류를 빼고, 몇 건을 뺐는지 함께 보여 준다.

Claude Desktop 수집은 로컬 Chromium HTTP 캐시만 읽는다. Claude의 비공개 API나 동기화용 WebSocket은 부르지 않는다. 캐시에서 세 가지를 모은다.

- Claude Desktop이 보여 준 아티팩트 HTML
- 채팅이 `/mnt/user-data/outputs/`에 쓴 파일. 내려받은 파일은 바이트가 그대로다. 대화 내용으로 다시 만든 파일에는 셸 명령으로 고친 내용이 빠진다.
- 채팅 위젯. 위젯마다 HTML 페이지로 저장한다.

캐시에는 Claude Desktop에서 연 대화만 남는다. output-mesh는 모은 파일의 사본을 따로 두므로, 캐시에서 지워져도 카탈로그에는 남는다. Claude Desktop이 비공개 캐시 형식을 바꾸면 이 출처는 멈출 수 있다.

Gemini 수집은 Antigravity, Antigravity CLI, Antigravity IDE의 로컬 데이터만 읽는다. 세션 산출물과, `write_to_file` 또는 `replace_file_content`가 고친 현재 파일을 모은다. scratch 파일, 업로드, 내부에서 만든 파일, 메타데이터, `.resolved` 파생본, 백업, Gemini 웹 Canvas, 내려받은 이미지는 모으지 않는다. Gemini 계정 파일을 읽거나 Gemini 서비스에 요청을 보내지 않는다. 저장소 파일이 지워졌으면 그 파일은 모으지 않는다.

Antigravity 대화 기록에는 JSON이 아닌 줄이 가끔 섞여 있다. output-mesh는 그 줄만 건너뛰고 줄마다 경고를 한 번 남긴다. 경고는 수집 오류가 아니다.

git worktree는 본 저장소의 일부로 센다. 트리에서는 그 저장소 아래에 `⑂ 이름` 묶음으로 나온다. 에이전트가 일한 저장소라면 그 저장소의 worktree도 모두 감시한다. worktree를 처음 읽을 때는 만든 뒤에 바뀐 문서만 모은다. 나머지는 체크아웃으로 생긴 사본이기 때문이다. Claude Code의 세션 임시 폴더(`/private/tmp/claude-*/`)에서는 이미지만 모은다. 에이전트가 스크립트로 찍은 스크린샷 같은 것이다. 나머지 파일은 작업 메모와 로그라 모으지 않는다. 이 이미지는 위치 옆에 "임시" 표시가 붙고, 복사하지 않는다. Claude Code가 폴더를 정리하거나 재부팅으로 지워지면 라이브러리에서도 빠진다. "최근 변경"에는 한 세션의 이미지를 한 줄로 묶어 보여 준다. 이 이미지는 기본으로 숨긴다. 목록·피드·활동에서 보려면 필터 패널의 **임시 이미지 보기**를 켠다. 개요 머리 줄에 숨긴 개수가 나오고, 그 줄을 눌러도 켜진다.

## 쓰는 법

### 탐색기(왼쪽)

탐색기에는 검색창, 기간(전체, 오늘, 7일, 30일, 90일), 필터 버튼, 트리가 있다.

- **필터.** 필터 패널은 미리보기 위에 떠서 트리를 밀어내지 않는다. 고른 값은 버튼 옆에 토큰으로 남고, 토큰의 `×`를 누르면 그 값만 풀린다.
- **여러 값 고르기.** 한 묶음에서 여러 값을 고를 수 있다(예: Codex와 Claude Code). 같은 묶음 안에서는 하나만 맞아도 되고, 묶음끼리는 모두 맞아야 한다.
- **트리 묶기.** 저장소, 에이전트, 앱, 날짜, 종류로 묶을 수 있다. 에이전트로 묶으면 제품이 회사 아래에 모인다(예: Claude 아래 Claude Code와 Claude Desktop).
- **로고.** 폴더마다 그 안의 파일을 만든 에이전트의 로고가 붙는다.
- **부제.** 파일마다 문서 제목이 붙는다. 제목이 "README", "Product"처럼 너무 흔하면 그 파일을 만든 작업이 대신 붙는다.
- **큰 폴더.** 에이전트가 산출물 폴더에 프로젝트를 통째로 만들면 트리에서는 한 줄로 접힌다. 그 줄을 누르면 안의 파일이 펼쳐진다.
- **메뉴.** 줄을 오른쪽 클릭하거나 `Shift+F10`을 누르면 메뉴가 열린다. 최종본, 즐겨찾기, Finder에서 보기, 경로 복사가 있다.

검색어를 넣으면 트리 대신 관련도순 목록이 나온다. 결과마다 위치와 본문에서 일치한 부분이 붙고, 결과를 열면 미리보기가 일치한 곳을 칠하고 첫 번째 일치로 이동한다.

### 개요(오른쪽, 파일을 고르지 않았을 때)

개요는 위젯 격자다. 기본으로 최근 변경, 최종본, 활동 그래프, 종류·에이전트·작업공간 분포가 보인다. 임시 이미지를 보이게 켜면 그 이미지를 세션별로 묶어 작은 그림으로 보여 주는 임시 이미지 위젯도 나온다. 최근 작업, 수집 상태, 즐겨찾기, 태그 위젯도 켤 수 있다.

- 위젯을 옮기려면 손잡이를 끌고, 크기를 바꾸려면 오른쪽 아래 모서리를 끈다.
- **위젯 구성**에서 위젯을 켜고 끄거나, 옮기거나, 기본 배치로 되돌린다. 이 패널은 키보드로도 다룰 수 있다.

최근 변경은 에이전트가 만들고, 고치고, 옮기고, 지운 파일을 보여 준다. 아래로 스크롤하면 30일 전까지 거슬러 올라간다. 에이전트가 고친 지 4시간이 지나서야 발견한 변경은 여기에 올리지 않는다.

활동 그래프는 에이전트 활동을 시간, 날, 주 단위로 보여 준다. 정확한 숫자는 **표**로 바꿔서 본다. 그래프의 막대를 누르면 그 값으로 필터가 걸린다.

### 상세(오른쪽, 파일을 골랐을 때)

미리보기가 화면 대부분을 차지한다. 마크다운은 서식을 입혀 보여 주고, 프런트매터는 표로 정리한다. 소스 코드는 색과 줄 번호를 붙여 보여 준다. draw.io 도면은 읽기 전용 뷰어로 그린다.

정보 패널에는 이 파일을 고친 모든 세션과 태그, 메모, 최종본 표시가 있다.

### 활동

활동 보기는 에이전트 세션과 각 세션이 쓴 파일을 실시간 타임라인으로 보여 준다. 임시 이미지를 보이게 켜면, 작업 폴더의 이미지는 다른 파일과 따로 묶어 "임시" 표시와 작은 그림으로 보여 준다. 파일을 고르지 않으면 타임라인이 화면 전체를 쓴다. 파일을 고르면 타임라인은 왼쪽 칸으로 옮겨 가고 오른쪽에 파일이 열린다.

### 수집 오류

수집 중에 오류가 나면 상단 바에 "수집 오류"가 한 시간 동안 보인다. 누르면 최근 오류 목록이 열린다. 한 번 누른 뒤에는 더 새로운 오류가 생길 때까지 상단 바가 평소 상태로 돌아간다.

### 여러 기기

[Tailscale](https://tailscale.com)을 쓰면 tailnet 안에서 output-mesh가 돌고 있는 다른 기기를 찾아 준다. 상단 바의 기기 이름을 누르면 그 목록이 보인다. 기기마다 자기 카탈로그를 따로 두고, 기기를 누르면 그 기기의 카탈로그가 열린다.

기기를 더하려면 그 기기에서 다음 명령을 실행한다.

```bash
output-mesh install
tailscale serve --bg 19843
```

서버는 여전히 `127.0.0.1`에서만 연결을 받는다. 바깥에서의 접근은 Tailscale이 tailnet 안으로만 열어 준다.

### 키보드

- `↑` `↓`: 트리에서 이동하면서 파일을 연다.
- `←` `→`: 폴더를 접거나 펼친다.
- `/`: 검색한다. `f`: 필터를 연다.
- 제목을 누르면 개요로 돌아간다. 브라우저의 뒤로 가기도 된다.

## 명령

```bash
output-mesh                  # serve와 같다
output-mesh serve [--port N] # 기본 주소는 http://127.0.0.1:19843
output-mesh sweep            # 한 번 수집하고 끝낸다
output-mesh import <경로>    # 폴더나 파일을 등록한다 (복사하지 않는다)
output-mesh coverage         # 무엇을 모았고 무엇을 왜 뺐는지
output-mesh doctor           # 상태 점검: 출처, 데이터베이스, 검색 색인, 최근 오류
output-mesh compact          # 카탈로그 데이터베이스의 빈 공간을 회수한다
output-mesh install          # 서비스로 등록한다. 지금 켜고 로그인할 때마다 켠다
output-mesh start|stop|restart|status
output-mesh uninstall        # 서비스를 지운다
output-mesh --version        # 버전 (탐색기 아래쪽에도 보인다)
```

모든 명령은 `--db <경로>`로 다른 카탈로그 파일을 쓸 수 있다.

카탈로그 데이터베이스는 빈 공간을 저절로 줄이지 않는다. 시작 화면에 회수할 수 있는 공간이 보이면 `output-mesh compact`를 실행한다. 실행하는 동안 카탈로그가 잠기고, 몇 초가 걸릴 수 있다.

## 하지 않는 것

- **원본에 쓰기.** 세션 폴더, 로그, 저장소는 읽기만 한다. Aside의 `state.db`도 읽기 전용으로 연다.
- **파일 복사.** 색인은 원본 파일을 가리키기만 한다. 예외는 Claude Desktop 하나다. 캐시 항목은 파일이 아니어서 카탈로그 폴더에 사본을 둔다.
- **네트워크에 열기.** 서버는 `127.0.0.1`에서만 연결을 받는다.
- **에이전트가 만든 HTML이 바깥에 요청하기.** 미리보기는 같은 출처 권한이 없는 격리 프레임에서 `connect-src 'none'`으로 그린다. 스크립트는 파일마다 허용하기 전까지 막혀 있고, 허용해도 네트워크는 닫혀 있다. 예외가 하나 있다. draw.io 미리보기는 도면 파일이 가리키는 도형 이미지를 불러온다.

카탈로그는 `~/Library/Application Support/AgentOutputCatalog/catalog.db`에 있다. 태그, 메모, 즐겨찾기, 최종본 표시를 빼면 모두 디스크에서 다시 만들 수 있고, 이 네 가지는 수집이 덮어쓰지 않는다.

## 참고

- 스프레드시트 본문을 뽑을 때 시스템 `unzip`을 쓴다.
- `~/Downloads`, `~/Desktop`, `~/Documents`에서 가져오려면 `bun` 실행 파일에 전체 디스크 접근 권한을 한 번 줘야 한다.
- 에이전트가 셸 명령으로 쓴 파일은 로그에 경로가 남지 않는다. 문서는 저장소 감시로 찾지만 세션 정보가 붙지 않고, 그렇게 쓴 소스 코드는 모으지 않는다.
- 스프레드시트 미리보기는 값만 보여 준다(시트마다 처음 200행, 30열). 서식, 병합한 셀, 차트는 보이지 않는다.
- PDF는 미리볼 수 있지만 본문 검색은 아직 안 된다. 이미지 속 글자는 읽지 않는다(OCR 없음).

## 개발

```bash
bun test      # 테스트
make check    # 린트와 테스트
```

설계 메모는 [DESIGN.md](./DESIGN.md)에, 데이터 모델을 이렇게 정한 이유는 [CLAUDE.md](./CLAUDE.md)에 있다.

## 라이선스

[MIT](./LICENSE)
