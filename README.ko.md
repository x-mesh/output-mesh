<p align="center">
  🇰🇷 한국어 | 🇺🇸 <a href="./README.md">English</a>
</p>

<h1 align="center">output-mesh</h1>

<p align="center">
  AI 에이전트가 만든 것을 한곳에 모으는 로컬 카탈로그.<br />
  어떤 산출물이든 몇 초 안에 찾고, 안전하게 미리 보고, 어느 에이전트의 어느 작업에서 나왔는지 본다.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/bun-%3E%3D1.3-black" alt="Bun >= 1.3" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="Platform: macOS" />
  <img src="https://img.shields.io/badge/runtime%20deps-0-brightgreen" alt="런타임 의존성 0개" />
</p>

## 왜 필요한가

에이전트는 보고서, PRD, 스프레드시트, HTML 시안, 이미지를 세션 폴더와 저장소 여기저기에 쓴다. 일주일 뒤에는 무슨 작업이었는지는 기억나도 파일 이름이나 위치는 기억나지 않는다. 게다가 절반은 이름이 `README.md` 나 `SKILL.md` 다.

output-mesh 는 그 자리들을 **건드리지 않고 읽기만 해서** 라이브러리 하나로 모은다. 파일 이름, 본문, 그 파일을 만든 작업으로 검색할 수 있고, 모든 파일에 만든 에이전트, 세션, 저장소가 붙어 있다.

## 시작하기

macOS 와 [Bun](https://bun.sh) 1.3 이상이 필요하다. 설치할 것은 없다.

```bash
bunx github:x-mesh/output-mesh
```

http://127.0.0.1:19843 을 연다. 화면은 영어와 한국어를 지원한다. 브라우저 언어를 따르고, 상단 바의 `KO` / `EN` 으로 바꾼다. 터미널 출력(첫 실행 진행 표시, 명령 도움말)은 아직 한국어만이다.

처음 실행하면 에이전트 로그를 한 번 모두 읽고, 그동안 진행 상황을 보여준다(Apple Silicon Mac 에서 Codex 로그 3.6 GB 기준 약 20초). 다음부터는 바뀐 것만 읽는다.

`npx` 로는 돌지 않는다. Bun 에 내장된 SQLite 를 쓰기 때문이다. 저장소를 받아서 돌리려면:

```bash
git clone https://github.com/x-mesh/output-mesh.git
cd output-mesh
bun bin/output-mesh.mjs
```

## 무엇을 모으나

| 출처 | 위치 | 방법 |
|---|---|---|
| Aside | `~/.aside/u/<계정>/sessions/<날짜>_<id>/artifacts/` | 폴더 감시, Aside 의 `state.db` 로 보강(읽기 전용으로 연다) |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 세션 로그의 `apply_patch` 마커에서 쓴 경로 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `Write` / `Edit` 도구 호출의 `file_path` |
| 그 밖의 것 | 직접 고른 폴더나 파일 | `output-mesh import <경로>` |

Codex 와 Claude Code 는 산출물을 따로 모아 두지 않는다. 대신 로그에 어느 경로에 썼는지가 남아서, 아직 저장소에 있는 파일에 출처만 붙이고 파일은 그 자리에 둔다.

라이브러리에는 문서, 웹 페이지, 이미지, 스프레드시트, 묶음 폴더가 보인다. 소스 코드와 모르는 형식도 모으지만 기본으로 숨긴다. 필요하면 종류 필터에서 고른다.

## 쓰기

**탐색기(왼쪽).** 검색, 기간(전체 · 오늘 · 7일 · 30일 · 90일), 접히는 필터, 트리. 트리는 저장소, 에이전트, 앱, 날짜, 종류로 묶을 수 있다. 파일마다 부제가 붙는다. 문서가 스스로 밝힌 제목이 먼저고, 제목이 "README", "Product" 처럼 아무 말도 하지 않으면 그 파일을 만든 작업이 나온다.

**개요(오른쪽, 아무것도 고르지 않았을 때).** 기간에 따라 시간, 날, 주 단위로 본 에이전트 활동과 종류 · 에이전트 · 작업공간 분포. 막대를 누르면 그대로 필터가 된다.

**상세(오른쪽, 파일을 골랐을 때).** 미리보기가 화면을 차지한다. 마크다운은 렌더해서 보여주고 프런트매터는 표로 정리한다. 정보 패널에는 이 파일을 건드린 모든 세션과 태그, 메모, 최종본 표시가 있다.

**활동.** 에이전트 세션과 각 세션이 쓴 파일을 실시간 타임라인으로 본다.

키보드: `↑` `↓` 이동하며 열기, `←` `→` 접기와 펼치기, `/` 검색. 제목을 누르면 개요로 돌아가고, 브라우저 뒤로 가기도 된다.

## 명령

```bash
output-mesh                  # serve 와 같다
output-mesh serve [--port N] # 기본 http://127.0.0.1:19843
output-mesh sweep            # 한 번 수집하고 끝낸다
output-mesh import <경로>    # 폴더나 파일을 등록한다(복사하지 않는다)
output-mesh coverage         # 무엇이 왜 빠졌는지
output-mesh doctor           # 출처 경로, 데이터베이스, FTS5 상태
```

모든 명령은 `--db <경로>` 로 다른 카탈로그 파일을 쓸 수 있다.

## 하지 않는 것

- **원본에 쓰기.** 세션 폴더, 로그, 저장소는 읽기만 한다. Aside 의 `state.db` 는 읽기 전용으로 연다.
- **파일 복사.** 색인은 원본을 가리키기만 한다.
- **내 컴퓨터 밖으로 열기.** 서버는 `127.0.0.1` 에만 붙는다.
- **에이전트가 만든 HTML 이 밖으로 요청하기.** 미리보기는 같은 출처 권한이 없는 격리 프레임에서 `connect-src 'none'` 으로 그린다. 스크립트는 파일마다 허용하기 전까지 막혀 있고, 허용해도 네트워크는 닫혀 있다.

카탈로그는 `~/Library/Application Support/AgentOutputCatalog/catalog.db` 에 있다. 태그, 메모, 즐겨찾기, 최종본 표시만 빼면 전부 디스크에서 다시 만들 수 있고, 그 넷은 수집이 덮어쓰지 않는다.

## 참고

- 스프레드시트 본문 추출에 시스템 `unzip` 을 쓴다.
- `~/Downloads`, `~/Desktop`, `~/Documents` 에서 가져오려면 `bun` 바이너리에 전체 디스크 접근 권한이 한 번 필요하다.
- Claude Code 가 `Write` 도구가 아니라 셸로 쓴 파일은 로그에 경로가 남지 않아 찾지 못한다.
- PDF 는 미리보기는 되지만 본문 검색은 아직 안 된다. 이미지 글자 인식(OCR)은 하지 않는다.

## 개발

```bash
bun test      # 테스트
make check    # 린트 + 테스트
```

설계 메모는 [DESIGN.md](./DESIGN.md), 데이터 모델의 이유는 [CLAUDE.md](./CLAUDE.md) 에 있다.

## 라이선스

[MIT](./LICENSE)
