import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectProgressText, createSpinner, formatBytes } from '../lib/spinner.mjs';
import { CatalogStore } from '../lib/store.mjs';
import { collectSessionLogs } from '../lib/collector.mjs';
import { Watcher } from '../lib/watcher.mjs';

const ESC = String.fromCharCode(27);
const sink = (isTTY) => {
  const out = [];
  return { isTTY, write: (text) => out.push(text), out };
};

describe('스피너', () => {
  test('터미널이 아니면 제어 문자 없이 단계가 바뀔 때만 한 줄씩 쓴다 — 로그 파일이 숫자로 뒤덮이지 않게', () => {
    const pipe = sink(false);
    const spinner = createSpinner(pipe);
    spinner.start('Preparing to collect');
    spinner.update('Reading Codex logs 1 MB', 'Reading Codex logs');
    spinner.update('Reading Codex logs 2 MB', 'Reading Codex logs');
    spinner.update('Indexing text 1/3', 'Indexing text');
    spinner.stop('Collected');

    expect(pipe.out).toEqual(['Preparing to collect\n', 'Reading Codex logs\n', 'Indexing text\n', 'Collected\n']);
    expect(pipe.out.join('')).not.toContain(ESC);
  });

  test('터미널에서는 진행 보고가 오면 타이머 없이도 프레임을 넘긴다 — 동기 파싱 중에는 타이머가 못 돈다', () => {
    const tty = sink(true);
    let clock = 0;
    const spinner = createSpinner(tty, { frameMs: 80, now: () => clock });
    spinner.start('Preparing to collect');
    const afterStart = tty.out.length;

    clock = 40;
    spinner.update('too soon');
    expect(tty.out.length).toBe(afterStart);

    clock = 120;
    spinner.update('Reading Codex logs');
    expect(tty.out.at(-1)).toContain('Reading Codex logs');

    spinner.stop('Collected');
    expect(tty.out.join('')).toContain(`${ESC}[?25l`);
    expect(tty.out.at(-2)).toContain(`${ESC}[?25h`);
    expect(tty.out.at(-1)).toBe('Collected\n');
  });

  test('진행 문구', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3.6 * 1024 ** 3)).toBe('3.6 GB');
    const [line, step] = collectProgressText({ step: 'logs', source: 'codex', done: 1024 ** 3, total: 3 * 1024 ** 3, files: 412, fileTotal: 1256 });
    expect(line).toContain('1.0 GB / 3.0 GB');
    expect(line).toContain('412/1,256');
    expect(step).toBe('Reading Codex logs (1,256 files, 3.0 GB)');
  });
});

describe('수집 진행 보고', () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'a-out-progress-'));
    store = new CatalogStore(join(dir, 'c.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('로그 진행률은 파일 개수가 아니라 바이트다 — 로그 크기가 KB 부터 수백 MB 까지라 개수는 널뛴다', async () => {
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    const small = join(logs, 'a.jsonl');
    const large = join(logs, 'b.jsonl');
    writeFileSync(small, 'x');
    writeFileSync(large, 'y'.repeat(4096));
    const source = { collector: 'codex', provider: 'openai-codex', root: logs, suffix: '.jsonl', cursorKey: 'codex.scanned_until', parse: () => [] };

    const events = [];
    await collectSessionLogs(store, [source], { onProgress: (p) => events.push(p) });

    const reads = events.filter((e) => e.step === 'logs');
    const total = statSync(small).size + statSync(large).size;
    expect(reads.map((e) => e.total)).toEqual([total, total]);
    expect(reads.map((e) => e.fileTotal)).toEqual([2, 2]);
  });

  test('동기 파싱 중에도 이벤트 루프에 차례가 온다 — 안 오면 Ctrl-C 와 스피너 타이머가 파싱이 끝날 때까지 멈춘다', async () => {
    const { COLLECT_YIELD_MS } = await import('../lib/paths.mjs');
    const logs = join(dir, 'busy');
    mkdirSync(logs);
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(logs, `${name}.jsonl`), 'x');
    const busy = () => {
      const until = performance.now() + COLLECT_YIELD_MS * 0.6;
      while (performance.now() < until) { /* 동기 파서를 흉내 낸다 */ }
      return [];
    };
    const source = { collector: 'codex', provider: 'openai-codex', root: logs, suffix: '.jsonl', cursorKey: 'codex.scanned_until', parse: busy };

    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await collectSessionLogs(store, [source]);
    const during = ticks;
    clearInterval(timer);
    expect(during).toBeGreaterThan(0);
  });

  test('진행 보고는 첫 수집에만 달린다 — 30초마다 도는 주기 수집은 조용하다', async () => {
    const path = join(dir, 'doc.md');
    writeFileSync(path, '# 제목');
    const pending = () => {
      const id = store.byPathKey(path)?.id ?? store.insertArtifact({ pathKey: path, absPath: path, fileName: 'doc.md', ext: 'md', sizeBytes: 1, contentHash: 'h', fileId: null, mtime: 1 });
      store.upsertSearchDoc(id, { name: 'doc.md', path, body: null, bodyState: 'pending' });
    };
    const events = [];
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false });

    pending();
    await watcher.start({ onProgress: (p) => events.push(p) });
    const firstRun = events.length;
    pending();
    await watcher.collect();
    watcher.stop();

    expect(firstRun).toBeGreaterThan(0);
    expect(events.length).toBe(firstRun);
  });
});

describe('닫힌 출력', () => {
  test('파이프가 끊겨도 수집을 죽이지 않는다 — EPIPE 가 sweep_failed 로 올라오던 실패', () => {
    const broken = {
      isTTY: true,
      write() {
        throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' });
      },
    };
    const spinner = createSpinner(broken);
    expect(() => spinner.note('안내')).not.toThrow();
    expect(() => spinner.start('Preparing to collect')).not.toThrow();
    expect(() => spinner.update('진행')).not.toThrow();
    expect(() => spinner.stop()).not.toThrow();
  });
});
