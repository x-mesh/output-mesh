import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROMPT_CHARS, claudeWrites, codexReads, codexWrites, isIndexablePath, logFilesSince, looksLikePrompt, newLogTail, shellReads } from '../lib/session-logs.mjs';
import { CatalogStore } from '../lib/store.mjs';
import { sweepSessionLogs } from '../lib/collector.mjs';
import { LOG_READ_CHUNK_BYTES, READING_MAX, READING_WINDOW_S, nfc } from '../lib/paths.mjs';
import { Watcher } from '../lib/watcher.mjs';

let dir;
let logs;
let repo;
let store;

const codexLog = (lines) => {
  const path = join(logs, `rollout-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'output-mesh-logs-'));
  logs = join(dir, 'logs');
  repo = join(dir, 'repo');
  mkdirSync(logs, { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  store = new CatalogStore(join(dir, 'c.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Codex rollout 파싱', () => {
  test('apply_patch 마커에서 쓴 경로를 뽑고 cwd 로 절대경로를 만든다', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 'sess-1', cwd: repo, timestamp: '2026-09-17T00:00:00Z' } },
      { type: 'response_item', payload: { name: 'exec', input: `apply_patch <<'EOF'\n*** Add File: src/app.swift\nEOF` } },
      { type: 'response_item', payload: { name: 'exec', input: `*** Update File: ${repo}/README.md` } },
    ]);
    const writes = codexWrites(path);
    expect(writes.map((w) => w.path).sort()).toEqual([join(repo, 'README.md'), join(repo, 'src/app.swift')].sort());
    expect(writes[0]).toMatchObject({ sessionRef: 'sess-1', workspace: repo });
  });

  test('마커가 없으면 파일을 통째로 건너뛴다', () => {
    expect(codexWrites(codexLog([{ type: 'event_msg', payload: { text: 'apply_patch 를 쓰라는 안내문' } }]))).toEqual([]);
  });

  test('로그 한 줄이 깨져도 나머지 마커는 살아남는다', () => {
    const path = join(logs, 'broken.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: repo } }),
      '{{{ 깨진 줄',
      JSON.stringify({ type: 'response_item', payload: { input: '*** Add File: src/ok.mjs' } }),
    ].join('\n'));
    expect(codexWrites(path).map((w) => w.path)).toEqual([join(repo, 'src/ok.mjs')]);
  });

  test('의존성·빌드 산출물 경로는 버린다', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 's', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Add File: node_modules/x/index.js' } },
      { type: 'response_item', payload: { input: '*** Add File: target/debug/out' } },
      { type: 'response_item', payload: { input: '*** Add File: src/keep.rs' } },
    ]);
    expect(codexWrites(path).map((w) => w.path)).toEqual([join(repo, 'src/keep.rs')]);
  });
});

describe('Claude Code transcript 파싱', () => {
  const transcript = (blocks) => {
    const path = join(logs, 'sess.jsonl');
    writeFileSync(path, blocks.map((b) => JSON.stringify(b)).join('\n'));
    return path;
  };

  test('Write·Edit 의 file_path 만 수확한다 — Read 는 산출물이 아니다', () => {
    const path = transcript([
      { sessionId: 'abc', cwd: repo, timestamp: '2026-09-17T00:00:00Z',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(repo, 'a.md') } }] } },
      { sessionId: 'abc', cwd: repo,
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(repo, 'b.md') } }] } },
      { sessionId: 'abc', cwd: repo,
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(repo, 'c.rs') } }] } },
    ]);
    expect(claudeWrites(path).map((w) => w.path).sort()).toEqual([join(repo, 'a.md'), join(repo, 'c.rs')].sort());
  });

  describe('지금 읽는 중', () => {
    const readAt = (secondsAgo, file) => ({
      sessionId: 'abc', cwd: repo, timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(repo, file) } }] },
    });

    test('Read 는 쓰기로 반환되지 않고 tail.reads 에만 쌓인다', () => {
      const tail = newLogTail();
      expect(claudeWrites(transcript([readAt(5, 'b.md')]), tail)).toEqual([]);
      expect(tail.reads).toEqual([expect.objectContaining({ path: join(repo, 'b.md'), sessionRef: 'abc', workspace: repo })]);
    });

    test('창 밖의 옛 읽기는 로그를 처음부터 다시 읽어도 받지 않는다', () => {
      const tail = newLogTail();
      claudeWrites(transcript([readAt(READING_WINDOW_S + 60, 'old.md'), readAt(5, 'new.md')]), tail);
      expect(tail.reads.map((read) => read.path)).toEqual([join(repo, 'new.md')]);
    });

    test('수집기는 읽기를 넘기고 비운다 — 받는 쪽이 없어도 쌓이지 않는다', async () => {
      const path = transcript([readAt(5, 'b.md')]);
      const source = { collector: 'claude-code', provider: 'claude-code', root: logs, suffix: '.jsonl', cursorKey: 'claude.scanned_until', parse: claudeWrites };
      const tails = new Map();
      const seen = [];
      await sweepSessionLogs(store, source, { tails, onRead: (read) => seen.push(read) });
      expect(seen).toEqual([expect.objectContaining({ collector: 'claude-code', path: join(repo, 'b.md') })]);
      expect(tails.get(path).reads).toEqual([]);
    });
  });

  test('같은 경로를 여러 번 고쳐도 한 번만 센다', () => {
    const block = { sessionId: 'abc', cwd: repo, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(repo, 'a.md') } }] } };
    expect(claudeWrites(transcript([block, block, block]))).toHaveLength(1);
  });
});

describe('경로 필터', () => {
  test.each([
    ['/Users/a/work/src/app.rs', true],
    ['/Users/a/work/node_modules/x.js', false],
    ['/Users/a/work/.git/HEAD', false],
    ['/Users/a/work/target/out', false],
    ['relative/path.md', false],
    // Claude Code 의 세션 임시 폴더만 거른다. 임시 폴더 전체나 저장소 안의 tmp/ 는 아니다.
    ['/private/tmp/claude-501/-Users-a-work/abc/scratchpad/pr-body.md', false],
    ['/tmp/claude-501/-Users-a-work/abc/scratchpad/pr-body.md', false],
    ['/tmp/experiment/note.md', true],
    ['/Users/a/work/tmp/notes.md', true],
  ])('%s -> %s', (path, want) => expect(isIndexablePath(path)).toBe(want));
});

describe('세션 로그 수집', () => {
  const source = () => ({
    collector: 'codex',
    provider: 'openai-codex',
    root: logs,
    suffix: '.jsonl',
    cursorKey: 'codex.scanned_until',
    parse: codexWrites,
  });

  test('존재하는 파일만 색인하고 출처와 작업공간을 붙인다', async () => {
    writeFileSync(join(repo, 'src', 'alive.mjs'), 'export const x = 1;');
    codexLog([
      { type: 'session_meta', payload: { id: 'sess-9', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Add File: src/alive.mjs' } },
      { type: 'response_item', payload: { input: '*** Add File: src/deleted.mjs' } },
    ]);

    const stats = await sweepSessionLogs(store, source());
    expect(stats).toMatchObject({ paths: 2, missing: 1, inserted: 1 });

    const row = store.byPathKey(nfc(join(repo, 'src', 'alive.mjs')));
    const [prov] = store.originsOf(row.id);
    expect(prov).toMatchObject({ collector: 'codex', provider: 'openai-codex', session_ref: 'sess-9', workspace: repo });
  });

  test('밀린 로그의 오래된 쓰기는 피드에 남기지 않고, 조금 전 쓰기는 그 시각으로 남긴다', async () => {
    writeFileSync(join(repo, 'src', 'old.mjs'), 'export const old = 1;');
    writeFileSync(join(repo, 'src', 'recent.mjs'), 'export const recent = 1;');
    const hourAgo = Date.now() - 3_600_000;
    const weeksAgo = Date.now() - 21 * 86_400_000;
    codexLog([
      { type: 'session_meta', payload: { id: 'weeks-ago', cwd: repo } },
      { type: 'response_item', timestamp: new Date(weeksAgo).toISOString(), payload: { input: '*** Add File: src/old.mjs' } },
    ]);
    codexLog([
      { type: 'session_meta', payload: { id: 'hour-ago', cwd: repo } },
      { type: 'response_item', timestamp: new Date(hourAgo).toISOString(), payload: { input: '*** Add File: src/recent.mjs' } },
    ]);

    expect(await sweepSessionLogs(store, source())).toMatchObject({ inserted: 2 });
    const feed = store.db
      .query('SELECT a.file_name, e.kind, e.session_ref, e.at FROM artifact_events e JOIN artifacts a ON a.id = e.artifact_id')
      .all();
    expect(feed).toEqual([{ file_name: 'recent.mjs', kind: 'created', session_ref: 'hour-ago', at: Math.floor(hourAgo / 1000) }]);
  });

  test('쓴 자리에 지금 폴더가 있어도 배치가 죽지 않는다 — EISDIR 하나에 뒤의 쓰기가 전부 버려지던 실패', async () => {
    mkdirSync(join(repo, 'src', 'now-a-dir'));
    writeFileSync(join(repo, 'src', 'after.mjs'), 'export const after = 1;');
    codexLog([
      { type: 'session_meta', payload: { id: 'sess-dir', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Add File: src/now-a-dir' } },
      { type: 'response_item', payload: { input: '*** Add File: src/after.mjs' } },
    ]);

    expect(await sweepSessionLogs(store, source())).toMatchObject({ paths: 2, missing: 1, inserted: 1 });
    expect(store.byPathKey(nfc(join(repo, 'src', 'after.mjs')))).not.toBeNull();
  });

  test('패치 본문까지 경로로 잡힌 줄도 없는 파일로 센다 — stat 이 ENAMETOOLONG 을 던진다', async () => {
    writeFileSync(join(repo, 'src', 'after.mjs'), 'export const after = 1;');
    codexLog([
      { type: 'session_meta', payload: { id: 'sess-long', cwd: repo } },
      { type: 'response_item', payload: { input: `*** Add File: src/${'x'.repeat(300)}.mjs` } },
      { type: 'response_item', payload: { input: '*** Add File: src/after.mjs' } },
    ]);

    expect(await sweepSessionLogs(store, source())).toMatchObject({ paths: 2, missing: 1, inserted: 1, failed: 0 });
  });

  test('파일 하나를 못 읽어도 나머지는 들어가고, 실패는 수집 기록에 남는다', async () => {
    const locked = join(repo, 'src', 'locked.mjs');
    writeFileSync(locked, 'export const locked = 1;');
    chmodSync(locked, 0o000);
    writeFileSync(join(repo, 'src', 'after.mjs'), 'export const after = 1;');
    codexLog([
      { type: 'session_meta', payload: { id: 'sess-locked', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Add File: src/locked.mjs' } },
      { type: 'response_item', payload: { input: '*** Add File: src/after.mjs' } },
    ]);

    try {
      expect(await sweepSessionLogs(store, source())).toMatchObject({ paths: 2, inserted: 1, failed: 1 });
    } finally {
      chmodSync(locked, 0o644);
    }
    expect(store.db.query("SELECT level, code, path FROM ingest_events WHERE code = 'ingest_failed'").all())
      .toEqual([{ level: 'error', code: 'ingest_failed', path: locked }]);
  });

  test('자동 발견은 최종본으로 올리지 않는다 — 산출물 플래그가 없다', async () => {
    writeFileSync(join(repo, 'src', 'a.mjs'), 'x');
    codexLog([
      { type: 'session_meta', payload: { id: 's', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Add File: src/a.mjs' } },
    ]);
    await sweepSessionLogs(store, source());
    expect(store.counts()).toMatchObject({ artifacts: 1, final: 0 });
  });

  test('커서가 진행하면 같은 로그를 다시 읽지 않는다', async () => {
    writeFileSync(join(repo, 'src', 'a.mjs'), 'x');
    codexLog([
      { type: 'session_meta', payload: { id: 's', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Add File: src/a.mjs' } },
    ]);
    await sweepSessionLogs(store, source());
    expect((await sweepSessionLogs(store, source())).logs).toBe(0);
  });

  test('mtime 커서보다 오래된 로그는 목록에서 빠진다', () => {
    codexLog([{ type: 'session_meta', payload: { id: 's', cwd: repo } }]);
    expect(logFilesSince(logs, '.jsonl', 0)).toHaveLength(1);
    expect(logFilesSince(logs, '.jsonl', Date.now() + 10_000)).toHaveLength(0);
  });
});

describe('세션 제목 추출', () => {
  test('지침 덤프와 도구 잡음을 건너뛰고 사람이 친 말을 고른다', () => {
    expect(looksLikePrompt('# AGENTS.md instructions for /repo\n<INSTRUCTIONS>')).toBe(false);
    expect(looksLikePrompt('<system-reminder>메모</system-reminder>')).toBe(false);
    expect(looksLikePrompt('<teammate-message teammate_id="lead">')).toBe(false);
    expect(looksLikePrompt('<image name=[Image #1] path="/var/x.png">')).toBe(false);
    expect(looksLikePrompt('term-mesh relay가 느리다. 확인해봐')).toBe(true);
  });

  test('Codex 의 환경 덤프, 스킬 호출 문구, 훅이 주입한 지시는 사람의 말이 아니다 — 활동 제목으로 샜다', () => {
    expect(looksLikePrompt('<environment_context>\n  <cwd>/w/repo</cwd>\n</environment_context>')).toBe(false);
    expect(looksLikePrompt('Invoke the `handon` skill to handle this request. Follow the instructions in `skills/handon`.')).toBe(false);
    expect(looksLikePrompt('[REQUIRED FINAL STEP — you MUST run this shell command before stopping] tm-agent done')).toBe(false);
    expect(looksLikePrompt('handon 스킬이 뭐 하는 건지 설명해줘')).toBe(true);
  });

  test('너무 긴 메시지는 프롬프트로 보지 않는다 — 대개 붙여넣은 덤프다', () => {
    expect(looksLikePrompt('가'.repeat(MAX_PROMPT_CHARS + 1))).toBe(false);
    expect(looksLikePrompt('가'.repeat(100))).toBe(true);
  });

  test('슬래시 커맨드 래퍼를 벗긴다', () => {
    const path = join(logs, 'sess.jsonl');
    writeFileSync(path, [
      { sessionId: 'a', cwd: repo, message: { role: 'user', content: '<system-reminder>무시</system-reminder>' } },
      { sessionId: 'a', cwd: repo, message: { role: 'user', content: 'User provided: PRD를 참고해서 만들어보자' } },
      { sessionId: 'a', cwd: repo, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(repo, 'a.md') } }] } },
    ].map((x) => JSON.stringify(x)).join('\n'));
    expect(claudeWrites(path)[0].prompt).toBe('PRD를 참고해서 만들어보자');
  });
});

describe('세션 로그 배치', () => {
  test('한 배치에 두 세션이 같은 경로를 써도 둘 다 남는다 — 스키마만 고치면 통과하지 못한다', async () => {
    writeFileSync(join(repo, 'src', 'shared.mjs'), 'export const x = 1;');
    for (const id of ['sess-a', 'sess-b', 'sess-c']) {
      codexLog([
        { type: 'session_meta', payload: { id, cwd: repo } },
        { type: 'response_item', payload: { input: '*** Update File: src/shared.mjs' } },
      ]);
    }
    const source = {
      collector: 'codex', provider: 'openai-codex', root: logs, suffix: '.jsonl',
      cursorKey: 'codex.scanned_until', parse: codexWrites,
    };

    await sweepSessionLogs(store, source);

    const row = store.byPathKey(nfc(join(repo, 'src', 'shared.mjs')));
    expect(store.originsOf(row.id).map((o) => o.session_ref).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(store.counts().multiOrigin).toBe(1);
  });
});

describe('Codex 패치 경로 — 이중 인코딩', () => {
  test('exec 도구 안에 든 패치도 경로 끝에 역슬래시가 붙지 않는다 — 214개 세션이 사라지던 실패', () => {
    // 요즘 Codex 는 apply_patch 를 exec 의 JS 문자열 안에 넣는다. 그 문자열의 `\n` 이 JSON 에
    // 한 번 더 이스케이프돼 원문에는 `a.swift\\n` 으로 남는다. String.raw 로 그 모양을 재현한다.
    const js = String.raw`const r = await tools.exec_command({cmd: "apply_patch <<'EOF'\n*** Update File: ${repo}/src/deep.swift\n@@\nEOF"})`;
    const path = codexLog([
      { type: 'session_meta', payload: { id: 's', cwd: repo } },
      { type: 'response_item', payload: { name: 'exec', input: js } },
    ]);
    expect(codexWrites(path).map((w) => w.path)).toEqual([join(repo, 'src/deep.swift')]);
  });

  test('쓰기마다 그 줄의 시각을 쓴다 — 세션 시작 시각이면 오래 도는 세션이 과거로 밀린다', () => {
    const path = codexLog([
      { timestamp: '2026-09-18T01:00:00Z', type: 'session_meta', payload: { id: 's', cwd: repo } },
      { timestamp: '2026-09-18T02:30:00Z', type: 'response_item', payload: { input: '*** Update File: src/a.mjs' } },
      { timestamp: '2026-09-18T02:40:00Z', type: 'response_item', payload: { input: '*** Update File: src/a.mjs' } },
    ]);
    const [write] = codexWrites(path);
    expect(write.at).toBe(Date.parse('2026-09-18T02:40:00Z') / 1000);
  });

  test('코드 안에 문자열로 든 패치는 따옴표에서 경로가 끝난다 — 패치 본문까지 경로가 되던 실패(실측 90건)', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 's', cwd: repo } },
      // 작은따옴표 배열로 조립한 패치: ['*** Update File: a.mjs','@@','   const x = 1;'].join('\n')
      { type: 'response_item', payload: { input: `const patch = ['*** Update File: ${repo}/src/panel.mjs','@@','   const timeoutMs = timeoutS * 1000;'].join('\\n')` } },
      // 백틱 문자열 안의 패치
      { type: 'response_item', payload: { input: 'String.raw`*** Begin Patch\n*** Update File: src/doctor.swift`' } },
    ]);
    expect(codexWrites(path).map((w) => w.path).sort()).toEqual([join(repo, 'src/doctor.swift'), join(repo, 'src/panel.mjs')]);
  });

  test('경로가 아닌 것은 버린다 — 템플릿의 빈칸과, 저장소 폴더 자체', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 's', cwd: repo } },
      { type: 'response_item', payload: { input: 'run(`*** Update File: ${current}`, ...body);' } },
      { type: 'response_item', payload: { input: `*** Update File: ${repo}/` } },
      { type: 'response_item', payload: { input: '*** Update File: .' } },
      { type: 'response_item', payload: { input: '*** Add File: src/real.mjs' } },
    ]);
    expect(codexWrites(path).map((w) => w.path)).toEqual([join(repo, 'src/real.mjs')]);
  });

  test('이름을 바꾼 패치는 새 경로를 잡는다', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 's', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Update File: src/old.mjs\n*** Move to: src/new.mjs' } },
    ]);
    expect(codexWrites(path).map((w) => w.path)).toContain(join(repo, 'src/new.mjs'));
  });
});

describe('파서 버전', () => {
  test('파서가 바뀌면 지나간 로그를 다시 읽는다 — 커서가 이미 지나가 수정이 무효가 되는 함정', async () => {
    const { collectSessionLogs } = await import('../lib/collector.mjs');
    const { SESSION_LOG_PARSER_VERSION } = await import('../lib/session-logs.mjs');
    writeFileSync(join(repo, 'src', 'late.mjs'), 'x');
    codexLog([
      { type: 'session_meta', payload: { id: 'late', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Add File: src/late.mjs' } },
    ]);
    const source = { collector: 'codex', provider: 'openai-codex', root: logs, suffix: '.jsonl', cursorKey: 'codex.scanned_until', parse: codexWrites };

    store.setState('codex.scanned_until', Date.now() + 60_000);
    store.setState('session_logs.parser_version', SESSION_LOG_PARSER_VERSION - 1);
    await collectSessionLogs(store, [source]);

    expect(store.byPathKey(nfc(join(repo, 'src', 'late.mjs')))).toBeTruthy();
    expect(store.getState('session_logs.parser_version')).toBe(String(SESSION_LOG_PARSER_VERSION));
  });
});

describe('Codex 스레드와 대화', () => {
  test('서브에이전트 스레드는 대화 id 를 갖고, 제목은 자기가 받은 마지막 지시다', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 'thread-7', session_id: 'conv-1', cwd: repo } },
      { type: 'response_item', payload: { role: 'user', content: '그럼 현상태에서 뭘할 수 있나?' } },
      { type: 'response_item', payload: { role: 'user', content: 'Fix the confirmed review findings' } },
      { type: 'response_item', payload: { input: '*** Update File: src/a.swift' } },
    ]);
    const [write] = codexWrites(path);
    expect(write).toMatchObject({ sessionRef: 'thread-7', conversationRef: 'conv-1', isRoot: false, prompt: 'Fix the confirmed review findings' });
  });

  test('루트 스레드의 제목은 첫 발화다 — 대화의 과제', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 'conv-1', session_id: 'conv-1', cwd: repo } },
      { type: 'response_item', payload: { role: 'user', content: 'relay 가 느리다. 확인해봐' } },
      { type: 'response_item', payload: { role: 'user', content: '계속' } },
      { type: 'response_item', payload: { input: '*** Update File: src/a.swift' } },
    ]);
    expect(codexWrites(path)[0]).toMatchObject({ isRoot: true, prompt: 'relay 가 느리다. 확인해봐' });
  });

  test('session_id 가 없는 옛 로그는 스레드가 곧 대화다', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 'old-1', cwd: repo } },
      { type: 'response_item', payload: { input: '*** Update File: src/a.swift' } },
    ]);
    expect(codexWrites(path)[0]).toMatchObject({ sessionRef: 'old-1', conversationRef: 'old-1', isRoot: true });
  });

  test('서브에이전트 알림은 제목이 되지 않는다', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 't', session_id: 'c', cwd: repo } },
      { type: 'response_item', payload: { role: 'user', content: '실제 지시' } },
      { type: 'response_item', payload: { role: 'user', content: '<subagent_notification>{"done":true}</subagent_notification>' } },
      { type: 'response_item', payload: { input: '*** Update File: src/a.swift' } },
    ]);
    expect(codexWrites(path)[0].prompt).toBe('실제 지시');
  });
});

describe('자라는 로그는 새로 붙은 줄만 읽는다', () => {
  const line = (entry) => `${JSON.stringify(entry)}\n`;
  const write = (sessionId, file) => line({ sessionId, cwd: repo, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(repo, file) } }] } });

  test('두 번째 읽기는 붙은 줄의 쓰기만 돌려주고, 앞에서 알아낸 세션·첫 발화는 그대로 쓴다', () => {
    const path = join(logs, 'live.jsonl');
    writeFileSync(path, line({ sessionId: 'live', cwd: repo, message: { role: 'user', content: '문서를 정리해줘' } }) + write('live', 'a.md'));
    const tail = newLogTail();
    expect(claudeWrites(path, tail).map((w) => w.path)).toEqual([join(repo, 'a.md')]);

    appendFileSync(path, write('live', 'b.md'));
    expect(claudeWrites(path, tail)).toEqual([{ path: join(repo, 'b.md'), sessionRef: 'live', workspace: repo, at: null, prompt: '문서를 정리해줘' }]);
    expect(claudeWrites(path, tail)).toEqual([]);
  });

  test('쓰는 중인 마지막 줄은 남겨 두었다가 완성되면 읽는다', () => {
    const path = join(logs, 'half.jsonl');
    const whole = write('half', 'late.md');
    writeFileSync(path, write('half', 'a.md') + whole.slice(0, 40));
    const tail = newLogTail();
    expect(claudeWrites(path, tail).map((w) => w.path)).toEqual([join(repo, 'a.md')]);

    appendFileSync(path, whole.slice(40));
    expect(claudeWrites(path, tail).map((w) => w.path)).toEqual([join(repo, 'late.md')]);
  });

  test('파일이 줄었거나 바뀌었으면 처음부터 다시 읽는다', () => {
    const path = join(logs, 'reset.jsonl');
    writeFileSync(path, write('one', 'a.md') + write('one', 'b.md'));
    const tail = newLogTail();
    claudeWrites(path, tail);

    writeFileSync(path, write('two', 'c.md'));
    expect(claudeWrites(path, tail)).toMatchObject([{ path: join(repo, 'c.md'), sessionRef: 'two' }]);
  });

  test('Codex: 세션 정보는 첫 조각, 패치는 뒤 조각에 있어도 cwd 로 경로를 푼다. 서브에이전트는 마지막 지시를 쓴다', () => {
    const path = join(logs, 'rollout-live.jsonl');
    writeFileSync(path, line({ type: 'session_meta', payload: { id: 'child', session_id: 'parent', cwd: repo } })
      + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '첫 지시' }] } }));
    const tail = newLogTail();
    expect(codexWrites(path, tail)).toEqual([]);

    appendFileSync(path, line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '두 번째 지시' }] } })
      + line({ type: 'response_item', payload: { input: '*** Add File: src/new.rs' } }));
    expect(codexWrites(path, tail)).toMatchObject([{ path: join(repo, 'src/new.rs'), sessionRef: 'child', conversationRef: 'parent', isRoot: false, workspace: repo, prompt: '두 번째 지시' }]);
  });

  test('읽기 조각 경계에 걸친 줄과 한글도 깨지지 않는다', () => {
    const path = join(logs, 'rollout-big.jsonl');
    const head = line({ type: 'session_meta', payload: { id: 'big', cwd: repo } });
    const filler = line({ type: 'event_msg', payload: { text: '가나다'.repeat(1000) } });
    const count = Math.ceil(LOG_READ_CHUNK_BYTES / Buffer.byteLength(filler)) + 1;
    const body = [head];
    for (let i = 0; i < count; i++) body.push(i === count - 2 ? line({ type: 'response_item', payload: { input: '*** Add File: src/경계.rs' } }) : filler);
    writeFileSync(path, body.join(''));
    expect(Buffer.byteLength(body.join(''))).toBeGreaterThan(LOG_READ_CHUNK_BYTES);

    expect(codexWrites(path).map((w) => w.path)).toEqual([join(repo, 'src/경계.rs')]);
  });

  test('수집기가 읽은 위치를 들고 있으면 이미 넣은 경로를 다시 넣지 않는다', async () => {
    writeFileSync(join(repo, 'src', 'one.mjs'), '1');
    writeFileSync(join(repo, 'src', 'two.mjs'), '2');
    const path = join(logs, 'rollout-sweep.jsonl');
    writeFileSync(path, line({ type: 'session_meta', payload: { id: 's', cwd: repo } }) + line({ type: 'response_item', payload: { input: '*** Add File: src/one.mjs' } }));
    const source = { collector: 'codex', provider: 'openai-codex', root: logs, suffix: '.jsonl', cursorKey: 'codex.scanned_until', parse: codexWrites };
    const tails = new Map();
    expect(await sweepSessionLogs(store, source, { tails })).toMatchObject({ paths: 1 });

    appendFileSync(path, line({ type: 'response_item', payload: { input: '*** Add File: src/two.mjs' } }));
    expect(await sweepSessionLogs(store, source, { tails })).toMatchObject({ logs: 1, paths: 1, inserted: 1 });
  });
});

describe('Watcher 의 지금 읽는 중', () => {
  const watcher = () => new Watcher(store, [], { useFsWatch: false, withSessionLogs: false });
  const read = (path, at, sessionRef = 's') => ({ collector: 'claude-code', provider: 'claude-code', sessionRef, workspace: '/w', path, at });

  test('최근 것이 먼저고 창이 지나면 사라진다', () => {
    const w = watcher();
    w.noteRead(read('/w/a.md', 1_000));
    w.noteRead(read('/w/b.md', 1_100));
    expect(w.reading(1_200).map((r) => r.path)).toEqual(['/w/b.md', '/w/a.md']);
    expect(w.reading(1_000 + READING_WINDOW_S + 1).map((r) => r.path)).toEqual(['/w/b.md']);
  });

  test('같은 세션이 같은 파일을 다시 읽으면 한 줄이고 시각만 오른다', () => {
    const w = watcher();
    w.noteRead(read('/w/a.md', 1_000));
    w.noteRead(read('/w/a.md', 1_050));
    expect(w.reading(1_060)).toEqual([expect.objectContaining({ path: '/w/a.md', at: 1_050 })]);
  });

  test('상한을 넘으면 가장 오래된 것부터 버린다', () => {
    const w = watcher();
    for (let i = 0; i < READING_MAX + 5; i++) w.noteRead(read(`/w/${i}.md`, 1_000 + i));
    const kept = w.reading(1_000 + READING_MAX + 5);
    expect(kept).toHaveLength(READING_MAX);
    expect(kept.at(-1).path).toBe('/w/5.md');
  });
});

describe('Codex 가 읽은 파일', () => {
  test('cat · sed -n · head · tail · nl 의 파일 인자를 읽기로 센다', () => {
    expect(shellReads("sed -n '1,220p' a.sh && sed -n '1,9p' b.sh", '/w')).toEqual(['/w/a.sh', '/w/b.sh']);
    expect(shellReads('head -n 20 /abs/y.md; tail -50 z.md; nl -ba n.md', '/w')).toEqual(['/abs/y.md', '/w/z.md', '/w/n.md']);
    expect(shellReads("cat a.md b.md 2>/dev/null || true", '/w')).toEqual(['/w/a.md', '/w/b.md']);
  });

  test('검색 · 파이프 뒤의 거르기 · 제자리 수정 · 변수 · 글롭은 읽기가 아니다', () => {
    expect(shellReads('rg foo lib', '/w')).toEqual([]);
    expect(shellReads("curl -s https://x | sed -n '1,80p'", '/w')).toEqual([]);
    expect(shellReads("sed -i 's/a/b/' x.md", '/w')).toEqual([]);
    expect(shellReads('cat $HOME/x.md src/*.js', '/w')).toEqual([]);
  });

  test('파이프 앞의 명령은 읽기다', () => {
    expect(shellReads("nl -ba a.rb | sed -n '1,80p'", '/w')).toEqual(['/w/a.rb']);
  });

  test('호출마다 자기 workdir 로 푼다', () => {
    const input = "await Promise.all([tools.exec_command({cmd:'cat a.md',workdir:'/p1'}), tools.exec_command({\"cmd\":\"cat b.md\",\"workdir\":\"/p2\"})])";
    expect(codexReads(input, '/d')).toEqual(['/p1/a.md', '/p2/b.md']);
    expect(codexReads('tools.exec_command({cmd:"cat c.md"})', '/d')).toEqual(['/d/c.md']);
  });

  test('최근 읽기만 tail.reads 에 쌓고, 로그를 처음부터 다시 읽어도 옛 읽기는 받지 않는다', () => {
    writeFileSync(join(repo, 'src', 'now.md'), '1');
    writeFileSync(join(repo, 'src', 'old.md'), '2');
    const call = (file, secondsAgo) => ({
      timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: `const r = await tools.exec_command({"cmd":"cat ${file}","workdir":"${repo}"});` },
    });
    const path = codexLog([
      { type: 'session_meta', payload: { id: 'th', session_id: 'conv', cwd: repo } },
      call('src/old.md', READING_WINDOW_S + 60),
      call('src/now.md', 5),
      call('src/missing.md', 5),
    ]);
    const tail = newLogTail();
    expect(codexWrites(path, tail)).toEqual([]);
    expect(tail.reads).toEqual([expect.objectContaining({ path: join(repo, 'src', 'now.md'), sessionRef: 'conv', workspace: repo })]);
  });

  test('도구 출력 줄에 exec_command 라는 글자가 있어도 읽기가 아니다', () => {
    const path = codexLog([
      { type: 'session_meta', payload: { id: 'th', cwd: repo } },
      { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'exec_command failed: cat src/x.md' } },
    ]);
    const tail = newLogTail();
    codexWrites(path, tail);
    expect(tail.reads ?? []).toEqual([]);
  });
});
