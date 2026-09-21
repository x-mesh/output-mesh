import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 도는 인스턴스를 적어 둔다. 서비스로 띄웠든 손으로 띄웠든 `stop` 과 `status` 가 같은 것을 본다 —
 * 이게 없으면 `bunx output-mesh` 로 띄운 것은 `pkill` 말고 멈출 길이 없다.
 *
 * 카탈로그 파일 이름을 그대로 딴다. 폴더 기준으로 잡으면 한 폴더에 카탈로그를 둘 두었을 때 서로
 * 도는 것처럼 보인다. 막아야 할 것은 **같은 카탈로그**에 둘이 붙는 것이지 기기에 하나만 띄우는
 * 것이 아니다 — 다른 카탈로그는 포트만 다르면 함께 돈다.
 */
export const runFileFor = (dbPath) => `${dbPath}.running.json`;

export function writeRun(dbPath, { pid = process.pid, port, at = Math.floor(Date.now() / 1000) }) {
  const path = runFileFor(dbPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ pid, port, at })}\n`);
  return path;
}

export function clearRun(dbPath, { pid = process.pid } = {}) {
  const found = readRun(dbPath);
  // 남이 적은 기록은 지우지 않는다. 먼저 뜬 서버가 살아 있는데 늦게 뜬 쪽이 나가며 지우면
  // 그 뒤로 stop 이 아무것도 못 찾는다.
  if (found && found.pid !== pid) return false;
  rmSync(runFileFor(dbPath), { force: true });
  return true;
}

/** 죽은 기록은 없는 것과 같다. 프로세스가 사라졌으면 지우고 null 을 준다. */
export function readRun(dbPath, { alive = isAlive } = {}) {
  const path = runFileFor(dbPath);
  if (!existsSync(path)) return null;
  let found;
  try {
    found = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    rmSync(path, { force: true });
    return null;
  }
  if (!Number.isInteger(found?.pid) || !alive(found.pid)) {
    rmSync(path, { force: true });
    return null;
  }
  return found;
}

/** 신호 0 은 보내지 않고 닿는지만 본다. 권한이 없으면(EPERM) 남의 프로세스이지만 살아는 있다. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
