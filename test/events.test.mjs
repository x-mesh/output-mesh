import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { ingestFile, recheckKnownFiles } from '../lib/collector.mjs';
import { recentChanges } from '../lib/search.mjs';
import { Watcher } from '../lib/watcher.mjs';
import { claudeWrites } from '../lib/session-logs.mjs';
import { nfc } from '../lib/paths.mjs';

let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'output-mesh-events-'));
  store = new CatalogStore(join(dir, 'c.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const codex = { collector: 'codex', provider: 'openai-codex', sessionRef: 's1' };
const events = () => store.db.query('SELECT kind, source, collector FROM artifact_events ORDER BY id').all();
const idOf = (path) => store.byPathKey(nfc(path)).id;

describe('변경 기록 — 규칙이 정해지는 자리에서만 남긴다', () => {
  test('생김, 바뀜, 옮김이 한 번씩 남는다', async () => {
    const path = join(dir, 'plan.md');
    writeFileSync(path, '처음');
    await ingestFile(store, path, codex);
    writeFileSync(path, '고친 내용');
    await ingestFile(store, path, codex);

    const moved = join(dir, 'plan-v2.md');
    renameSync(path, moved);
    store.quietEvents = true;
    store.markMissing([idOf(path)]);
    store.quietEvents = false;
    await ingestFile(store, moved, codex);

    expect(events()).toEqual([
      { kind: 'created', source: 'agent', collector: 'codex' },
      { kind: 'modified', source: 'agent', collector: 'codex' },
      { kind: 'moved', source: 'agent', collector: 'codex' },
    ]);
  });

  test('내용이 그대로면 몇 번을 다시 봐도 기록하지 않는다 — 30초마다 모든 파일이 이 길을 지난다', async () => {
    const path = join(dir, 'same.md');
    writeFileSync(path, '그대로');
    await ingestFile(store, path, codex);
    await ingestFile(store, path, codex);
    await ingestFile(store, path, { ...codex, sessionRef: 's2' });
    expect(events().map((e) => e.kind)).toEqual(['created']);
  });

  test('조용히 모드에서는 남기지 않는다 — 첫 수집의 수천 개가 "새로 생김"으로 피드를 덮지 않게', async () => {
    const path = join(dir, 'first.md');
    writeFileSync(path, 'x');
    store.quietEvents = true;
    await ingestFile(store, path, codex);
    store.quietEvents = false;
    expect(events()).toEqual([]);
  });
});

describe('찾아 둔 파일 다시 확인', () => {
  test('에이전트 밖에서 고친 것, 지운 것, 되살린 것을 잡는다', async () => {
    const path = join(dir, 'report.md');
    writeFileSync(path, '에이전트가 쓴 내용');
    await ingestFile(store, path, codex);
    const id = idOf(path);

    writeFileSync(path, '사람이 나중에 고친 더 긴 내용');
    expect(await recheckKnownFiles(store)).toMatchObject({ modified: 1 });
    expect(store.db.query('SELECT body_state FROM search_docs WHERE artifact_id = ?').get(id)).toBeNull();

    rmSync(path);
    expect(await recheckKnownFiles(store)).toMatchObject({ missing: 1 });
    expect(await recheckKnownFiles(store)).toMatchObject({ missing: 0 });

    writeFileSync(path, '다시 생김');
    expect(await recheckKnownFiles(store)).toMatchObject({ restored: 1 });

    expect(events()).toEqual([
      { kind: 'created', source: 'agent', collector: 'codex' },
      { kind: 'modified', source: 'disk', collector: null },
      { kind: 'missing', source: 'disk', collector: null },
      { kind: 'restored', source: 'disk', collector: null },
    ]);
  });

  test('NFD 이름의 파일도 같은 행으로 다시 확인한다 — 행이 둘로 갈라지지 않는다', async () => {
    const path = join(dir, '홍길동_이력서_초안.md'.normalize('NFD'));
    writeFileSync(path, '처음');
    await ingestFile(store, path, codex);
    writeFileSync(path, '나중에 고친 더 긴 내용');
    await recheckKnownFiles(store);
    expect(store.db.query('SELECT COUNT(*) AS n FROM artifacts').get().n).toBe(1);
    expect(events().map((e) => e.kind)).toEqual(['created', 'modified']);
  });

  test('바뀌지 않은 파일은 두 번 확인해도 기록이 없다', async () => {
    const path = join(dir, 'quiet.md');
    writeFileSync(path, 'x');
    await ingestFile(store, path, codex);
    await recheckKnownFiles(store);
    await recheckKnownFiles(store);
    expect(events().map((e) => e.kind)).toEqual(['created']);
  });

  test('Aside 출처 파일은 건드리지 않는다 — 스윕과 번갈아 사라짐·돌아옴을 적지 않게', async () => {
    const path = join(dir, 'aside.md');
    writeFileSync(path, 'x');
    await ingestFile(store, path, { collector: 'aside', sessionRef: 'a1' });
    rmSync(path);
    expect(await recheckKnownFiles(store)).toMatchObject({ checked: 0, missing: 0 });
  });
});

describe('워처와 변경 목록', () => {
  test('주입한 home 밖의 Claude Desktop cache를 읽지 않는다', () => {
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home: dir });
    expect(watcher.claudeReader.cacheDataRoot.startsWith(dir)).toBe(true);
    expect(watcher.claudeReader.outputDir.startsWith(dir)).toBe(true);
  });

  test('home 을 주입하면 Claude Code 임시 폴더를 읽지 않는다 — 그 폴더는 home 밖이다', () => {
    expect(new Watcher(store, [], { useFsWatch: false, withSessionLogs: true, home: dir }).scratchRoot).toBeNull();
    expect(new Watcher(store, [], { useFsWatch: false, withSessionLogs: true, home: dir, scratchRoot: join(dir, 'tmp') }).scratchRoot).toBe(join(dir, 'tmp'));
  });

  test('주입한 home 밖의 Gemini 데이터를 읽지 않는다', () => {
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home: dir });
    expect(watcher.geminiReader.roots.every((root) => root.startsWith(dir))).toBe(true);
  });

  test('Gemini 수집 실패 뒤에도 나머지 수집을 끝낸다', async () => {
    const geminiReader = { roots: [], brainRoots: [], scan: async () => { throw new Error('CANARY_SECRET'); } };
    const claudeReader = { sweep: async () => ({}) };
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: true, home: dir, geminiReader, claudeReader, sessionLogSources: [] });
    watcher.cursorReader = { available: () => false };
    const result = await watcher.collect();
    expect(result.find((entry) => 'gemini' in entry)).toEqual({ gemini: null });
    expect(result.some((entry) => 'indexed' in entry)).toBe(true);
    expect(store.getState('gemini.last_sweep_code')).toBe('failed');
    expect(JSON.stringify(store.recentIngestEvents())).not.toContain('CANARY_SECRET');
  });

  test('주기 수집이 Gemini reader를 호출한다', async () => {
    let scans = 0;
    const geminiReader = { roots: [], brainRoots: [], scan: async () => { scans++; return { available: true, records: [], stats: { roots: 0, sessions: 0, logs: 0, bytes: 0, writes: 0, artifacts: 0, missing: 0, skipped: 0, errors: 0 } }; }, availableRoots: () => [] };
    const claudeReader = { sweep: async () => ({}) };
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: true, home: dir, geminiReader, claudeReader, sessionLogSources: [] });
    watcher.cursorReader = { available: () => false };
    await watcher.collect();
    expect(scans).toBe(1);
  });

  test('세션 로그를 끈 워처는 Claude Desktop cache 를 수집하지 않는다', async () => {
    let swept = false;
    const claudeReader = { cacheDataRoot: join(dir, 'Cache_Data'), sweep: async () => { swept = true; return {}; } };
    await new Watcher(store, [], { useFsWatch: false, withSessionLogs: false, home: dir, claudeReader }).collect();
    expect(swept).toBe(false);
  });

  test('Claude Desktop cache 폴더는 감시하지 않는다', () => {
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: true, home: dir });
    expect(watcher.watchRoots().length).toBeGreaterThan(0);
    expect(watcher.watchRoots()).not.toContain(watcher.claudeReader.cacheDataRoot);
  });

  test('빈 카탈로그로 시작하면 첫 수집을 조용히 한다', async () => {
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false });
    let options;
    watcher.collect = async (opts) => {
      options = opts;
    };
    await watcher.start();
    watcher.stop();
    expect(options.quiet).toBe(true);
  });

  test('조용한 수집은 남기지 않고, 다음 수집은 새 변경 개수를 알린다 — 지운 줄 때문에 부풀지 않는다', async () => {
    const path = join(dir, 'doc.md');
    writeFileSync(path, 'x');
    await ingestFile(store, path, codex);
    store.db.query('DELETE FROM artifact_events').run();

    const payloads = [];
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: false });
    watcher.onCollect((p) => payloads.push(p));
    writeFileSync(path, '조용한 동안 고침');
    await watcher.collect({ quiet: true });
    writeFileSync(path, '그다음에 다시 고침, 더 길게');
    await watcher.collect();
    watcher.stop();

    expect(payloads.map((p) => p.changes)).toEqual([0, 1]);
    expect(events().map((e) => e.kind)).toEqual(['modified']);
  });

  test('라이브러리 필터를 따르고 사라진 파일의 기록도 보인다', async () => {
    const doc = join(dir, 'guide.md');
    const code = join(dir, 'main.rs');
    writeFileSync(doc, '# 안내서');
    writeFileSync(code, 'fn main() {}');
    await ingestFile(store, doc, { ...codex, workspace: dir });
    await ingestFile(store, code, { ...codex, workspace: dir });
    rmSync(doc);
    await recheckKnownFiles(store);

    const { changes, hidden } = recentChanges(store, '', { view: 'library' });
    expect(hidden).toEqual({ code: 1 });
    expect(changes.map((c) => [c.file_name, c.change])).toEqual([['guide.md', 'missing'], ['guide.md', 'created']]);
    expect(changes[0].location).toMatchObject({ dir: '/' });
  });

  test('디스크에서 본 변경에도 파일을 만든 에이전트가 따라온다 — 화면이 누구 파일인지 달 수 있게', async () => {
    const path = join(dir, 'notes.md');
    writeFileSync(path, '처음');
    await ingestFile(store, path, codex);
    await ingestFile(store, path, { collector: 'claude-code', provider: 'claude-code', sessionRef: 's2' });
    writeFileSync(path, '사람이 손으로 고침');
    await recheckKnownFiles(store);

    const [latest] = recentChanges(store, '', { view: 'library' }).changes;
    expect(latest).toMatchObject({ change: 'modified', source: 'disk', collector: null, collectors: ['claude-code', 'codex'] });
  });

  test('쪽으로 나눠 받아도 빠지거나 겹치는 줄이 없고, 숨긴 건수는 쪽마다 더하면 전체가 된다', async () => {
    const names = ['a.md', 'b.rs', 'c.md', 'd.md', 'e.rs', 'f.md', 'g.md'];
    for (const name of names) {
      writeFileSync(join(dir, name), name);
      await ingestFile(store, join(dir, name), { ...codex, workspace: dir });
    }
    const pages = [];
    let hidden = {};
    let before = null;
    for (;;) {
      const page = recentChanges(store, '', { view: 'library' }, 2, { before });
      pages.push(page.changes.map((c) => c.file_name));
      for (const [kind, n] of Object.entries(page.hidden)) hidden[kind] = (hidden[kind] ?? 0) + n;
      if (!page.more) break;
      before = page.changes.at(-1).id;
    }
    expect(pages).toEqual([['g.md', 'f.md'], ['d.md', 'c.md'], ['a.md']]);
    expect(hidden).toEqual({ code: 2 });
  });

  test('after 는 그 뒤에 생긴 줄만 준다 — 실시간 갱신이 불러 둔 이전 기록을 지우지 않게', async () => {
    writeFileSync(join(dir, 'old.md'), 'x');
    await ingestFile(store, join(dir, 'old.md'), codex);
    const [seen] = recentChanges(store, '', { view: 'library' }).changes;
    writeFileSync(join(dir, 'new.md'), 'y');
    await ingestFile(store, join(dir, 'new.md'), codex);

    const page = recentChanges(store, '', { view: 'library' }, 10, { after: seen.id });
    expect(page.changes.map((c) => c.file_name)).toEqual(['new.md']);
    expect(page.more).toBe(false);
  });

  test('오래된 기록은 지운다', async () => {
    const path = join(dir, 'old.md');
    writeFileSync(path, 'x');
    await ingestFile(store, path, codex);
    store.logIngest({ level: 'error', code: 'sweep_failed', message: '지난 일' });
    store.pruneEvents(Math.floor(Date.now() / 1000) + 1);
    expect(events()).toEqual([]);
    expect(store.recentIngestErrors()).toEqual([]);
  });
});

describe('밀린 변경 — 알아챈 때가 아니라 일어난 때로 본다', () => {
  const HOUR = 3_600;
  const now = () => Math.floor(Date.now() / 1000);
  const at = () => store.db.query('SELECT kind, at FROM artifact_events ORDER BY id').all();

  test('에이전트가 오래전에 쓴 파일은 피드에 남기지 않는다 — 재시작 직후 몇 주 전 파일이 "방금"으로 뜨던 실패', async () => {
    const path = join(dir, 'old.md');
    writeFileSync(path, '서버가 꺼져 있던 동안 쓴 문서');
    await ingestFile(store, path, { ...codex, createdAt: now() - 5 * HOUR });

    expect(events()).toEqual([]);
    expect(store.byPathKey(nfc(path))).not.toBeNull();
    expect(store.db.query('SELECT COUNT(*) AS n FROM artifact_origins').get().n).toBe(1);
  });

  test('기준 안의 변경은 남기고, 시각은 에이전트가 쓴 때다', async () => {
    const path = join(dir, 'recent.md');
    const wroteAt = now() - 3 * HOUR;
    writeFileSync(path, '세 시간 전에 쓴 문서');
    await ingestFile(store, path, { ...codex, createdAt: wroteAt });

    expect(at()).toEqual([{ kind: 'created', at: wroteAt }]);
  });

  test('오래된 세션이 고친 것도 남기지 않는다 — 생김만 거르면 바뀜으로 샌다', async () => {
    const path = join(dir, 'edited.md');
    writeFileSync(path, '처음');
    await ingestFile(store, path, codex);
    writeFileSync(path, '밀린 로그에서 뒤늦게 본 수정');
    await ingestFile(store, path, { ...codex, sessionRef: 's0', createdAt: now() - 30 * HOUR });

    expect(events().map((e) => e.kind)).toEqual(['created']);
  });

  test('로그의 시각이 미래여도 지금보다 늦게 적지 않는다', async () => {
    const path = join(dir, 'skew.md');
    writeFileSync(path, '시계가 어긋난 로그');
    const before = now();
    await ingestFile(store, path, { ...codex, createdAt: now() + HOUR });

    expect(at()[0].at).toBeGreaterThanOrEqual(before);
    expect(at()[0].at).toBeLessThanOrEqual(now());
  });

  test('세션이 없는 출처는 시각을 모르므로 지금으로 남긴다', async () => {
    const path = join(dir, 'README.md');
    writeFileSync(path, '저장소 문서');
    const before = now();
    await ingestFile(store, path, { collector: 'workspace', sessionRef: '', createdAt: now() - 30 * HOUR });

    expect(at()[0].at).toBeGreaterThanOrEqual(before);
  });
});

describe('수집 오류 — 다음 수집이 성공해도 가려지지 않는다', () => {
  const quietWatcher = () => new Watcher(store, [], { useFsWatch: false, withSessionLogs: false });

  test('파일 하나의 실패가 수집 알림에 실려 화면까지 간다', async () => {
    const watcher = quietWatcher();
    const seen = [];
    watcher.onCollect((payload) => seen.push(payload));
    store.logIngest({ path: '/x/locked.md', level: 'error', code: 'ingest_failed', message: 'EACCES: permission denied' });

    await watcher.collect();
    await watcher.collect();

    expect(seen.map((p) => p.type)).toEqual(['collected', 'collected']);
    expect(seen[1].error).toMatchObject({ code: 'ingest_failed', path: '/x/locked.md' });
    expect(watcher.status().recentError).toMatchObject({ code: 'ingest_failed' });
  });

  test('경고와 오래된 오류는 싣지 않는다', async () => {
    const watcher = quietWatcher();
    const seen = [];
    watcher.onCollect((payload) => seen.push(payload));
    store.logIngest({ path: '/x/busy.md', level: 'warn', code: 'hash_unstable', message: '쓰는 중' });
    store.logIngest({ level: 'error', code: 'sweep_failed', message: '어제 일', at: Math.floor(Date.now() / 1000) - 86_400 });

    await watcher.collect();

    expect(seen[0].error).toBeNull();
  });

  test('수집이 통째로 실패해도 화면에 알린다 — 실패한 수집은 아무것도 보내지 않아 "방금 수집"이 그대로였다', async () => {
    const watcher = quietWatcher();
    const seen = [];
    watcher.onCollect((payload) => seen.push(payload));
    const original = store.pruneEvents.bind(store);
    store.pruneEvents = () => {
      throw new Error('디스크가 가득 참');
    };

    await watcher.collect();
    store.pruneEvents = original;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'failed', error: { code: 'sweep_failed', message: '디스크가 가득 참' } });
  });
});

describe('세션 로그만 도는 가벼운 수집', () => {
  const setup = () => {
    const logs = join(dir, 'logs');
    mkdirSync(logs, { recursive: true });
    const source = { collector: 'claude-code', provider: 'claude-code', root: logs, suffix: '.jsonl', cursorKey: 'claude.scanned_until', parse: claudeWrites };
    let swept = 0;
    const claudeReader = { sweep: async () => { swept++; return {}; } };
    const watcher = new Watcher(store, [], { useFsWatch: false, withSessionLogs: true, home: dir, claudeReader, sessionLogSources: [source] });
    const seen = [];
    watcher.onCollect((payload) => seen.push(payload.type));
    const log = join(logs, 'sess.jsonl');
    const tool = (name, file) => JSON.stringify({ sessionId: 'abc', cwd: dir, timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name, input: { file_path: file } }] } }) + '\n';
    return { watcher, seen, log, tool, sweeps: () => swept };
  };

  test('쓰기가 있으면 수집 알림을, 읽기만 있으면 읽기 알림만 보낸다. 다른 수집기는 돌지 않는다', async () => {
    const { watcher, seen, log, tool, sweeps } = setup();
    const file = join(dir, 'a.md');
    writeFileSync(file, '# a');
    writeFileSync(log, tool('Write', file));
    await watcher.collectLogs();
    expect(seen).toEqual(['collected']);

    appendFileSync(log, tool('Read', file));
    await watcher.collectLogs();
    expect(seen).toEqual(['collected', 'reading']);
    expect(watcher.reading().map((read) => read.path)).toEqual([file]);
    expect(sweeps()).toBe(0);
  });

  test('겹치면 뒤에 온 수집을 미뤘다가 앞의 것이 끝나면 돌린다', async () => {
    const { watcher } = setup();
    watcher.logDelayMs = 0;
    watcher.running = true;
    expect(await watcher.collectLogs()).toBeNull();
    expect(watcher.pending.logs).toBe(true);
    watcher.running = false;
    watcher.runPending();
    expect(watcher.pending.logs).toBe(false);
    expect(watcher.logTimer).not.toBeNull();
    watcher.stop();
  });
});
