import { writeSync } from 'node:fs';
import { SPINNER_FRAME_MS } from './paths.mjs';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR_LINE = '\r\x1b[2K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// 셸 관례: 128 + 신호 번호. Ctrl-C 와 kill 둘 다 커서를 돌려놓고 나가야 한다.
const EXIT_ON_SIGNAL = { SIGINT: 130, SIGTERM: 143 };
const BYTES_PER_UNIT = 1024;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * 표준 오류에 동기로 쓴다. 첫 수집의 로그 파싱은 이벤트 루프를 붙잡으므로 비동기 쓰기는
 * 수집이 끝날 때까지 한꺼번에 밀린다. 표준 출력은 서버 주소 한 줄만 받도록 비워 둔다.
 */
export const stderrSink = { isTTY: Boolean(process.stderr.isTTY), write: (text) => writeSync(2, text) };

/**
 * 첫 수집을 기다리는 동안의 표시. 로그 파싱 중에는 타이머가 돌지 못한다 — 진행 보고가 올
 * 때마다 프레임을 직접 넘기고, 타이머는 루프가 한가한 단계(파일 확인)에서만 보탠다.
 * 터미널이 아니면(파이프, 로그 파일) 제어 문자 없이 단계가 바뀔 때만 한 줄씩 쓴다.
 */
export function createSpinner(sink = stderrSink, { frameMs = SPINNER_FRAME_MS, now = () => performance.now() } = {}) {
  let text = '';
  let milestone = '';
  let frame = 0;
  let lastDraw = -Infinity;
  let timer = null;

  const draw = () => {
    frame = (frame + 1) % FRAMES.length;
    lastDraw = now();
    sink.write(`${CLEAR_LINE}${FRAMES[frame]} ${text}`);
  };
  const restore = () => sink.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
  // 수집 도중 끊기면 숨긴 커서를 돌려놓고 나간다. 신호로 죽으면 'exit' 이벤트가 오지 않아서
  // 신호마다 따로 받는다. 안 그러면 셸에 커서가 사라진 채로 남는다.
  const handlers = Object.entries(EXIT_ON_SIGNAL).map(([signal, code]) => [signal, () => {
    restore();
    process.exit(code);
  }]);

  return {
    /** 스피너 없이 남길 안내 한 줄. console.error 는 Bun 이 터미널에서 빨갛게 칠해 오류처럼 보인다. */
    note(message) {
      sink.write(`${message}\n`);
    },

    start(message) {
      text = message;
      milestone = message;
      if (!sink.isTTY) {
        sink.write(`${message}\n`);
        return;
      }
      sink.write(HIDE_CURSOR);
      draw();
      timer = setInterval(draw, frameMs);
      for (const [signal, handler] of handlers) process.once(signal, handler);
      process.once('exit', restore);
    },

    /** step 은 터미널이 아닐 때 한 줄로 남길 단계 이름이다. 같은 단계의 숫자 변화는 쓰지 않는다. */
    update(message, step = message) {
      text = message;
      if (!sink.isTTY) {
        if (step !== milestone) sink.write(`${step}\n`);
        milestone = step;
        return;
      }
      if (now() - lastDraw >= frameMs) draw();
    },

    stop(finalMessage) {
      if (sink.isTTY) {
        clearInterval(timer);
        timer = null;
        restore();
        for (const [signal, handler] of handlers) process.off(signal, handler);
        process.off('exit', restore);
      }
      if (finalMessage) sink.write(`${finalMessage}\n`);
    },
  };
}

export function formatBytes(bytes) {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

const SOURCE_LABEL = { codex: 'Codex', 'claude-code': 'Claude Code', aside: 'Aside' };

/** 수집 진행 보고를 사람이 읽는 한 줄로. 두 번째 값은 터미널이 아닐 때 남길 단계 이름이다. */
export function collectProgressText(progress) {
  const count = (n) => n.toLocaleString('ko-KR');
  const who = SOURCE_LABEL[progress.source] ?? progress.source;
  switch (progress.step) {
    case 'aside':
      return ['Aside 산출물 확인 중', 'Aside 산출물 확인 중'];
    case 'logs':
      return [
        `${who} 로그 읽는 중  ${formatBytes(progress.done)} / ${formatBytes(progress.total)}  (${count(progress.files)}/${count(progress.fileTotal)}개)`,
        `${who} 로그 읽는 중 (${count(progress.fileTotal)}개, ${formatBytes(progress.total)})`,
      ];
    case 'files':
      return [`${who} 로그에서 찾은 파일 확인 중  ${count(progress.done)}/${count(progress.total)}`, `${who} 로그에서 찾은 파일 확인 중`];
    case 'index':
      return [`본문 색인 중  ${count(progress.done)}/${count(progress.total)}`, '본문 색인 중'];
    case 'recheck':
      return [`찾아 둔 파일 다시 확인 중  ${count(progress.done)}/${count(progress.total)}`, '찾아 둔 파일 다시 확인 중'];
    default:
      return ['수집 중', '수집 중'];
  }
}
