import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRun, isAlive, readRun, runFileFor, writeRun } from '../lib/running.mjs';

let dir;
let db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'a-out-running-'));
  db = join(dir, 'catalog.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('도는 인스턴스 기록', () => {
  test('카탈로그마다 따로 적는다 — 한 폴더의 두 카탈로그가 서로 도는 것처럼 보이면 안 된다', () => {
    writeRun(db, { pid: process.pid, port: 19843 });
    expect(readRun(db)).toMatchObject({ pid: process.pid, port: 19843 });
    expect(readRun(join(dir, 'other.db'))).toBeNull();
    expect(runFileFor(db)).toBe(`${db}.running.json`);
  });

  test('죽은 기록은 없는 것과 같다 — 남은 파일 하나가 영영 못 띄우게 만들면 안 된다', () => {
    writeRun(db, { pid: 999_999, port: 19843 });
    expect(readRun(db, { alive: () => false })).toBeNull();
    expect(existsSync(runFileFor(db))).toBe(false);
  });

  test('깨진 기록도 지우고 없는 것으로 본다', () => {
    writeFileSync(runFileFor(db), '{{{');
    expect(readRun(db)).toBeNull();
    expect(existsSync(runFileFor(db))).toBe(false);
  });

  test('남이 적은 기록은 지우지 않는다 — 먼저 뜬 서버를 stop 이 못 찾게 된다', () => {
    writeRun(db, { pid: process.pid, port: 19843 });
    expect(clearRun(db, { pid: process.pid + 1 })).toBe(false);
    expect(readRun(db)).not.toBeNull();
    expect(clearRun(db, { pid: process.pid })).toBe(true);
    expect(readRun(db)).toBeNull();
  });

  test('닿지 않는 pid 는 죽은 것으로 본다', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(999_999)).toBe(false);
  });
});
