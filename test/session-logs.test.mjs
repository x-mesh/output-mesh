import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROMPT_CHARS, claudeWrites, codexWrites, isIndexablePath, logFilesSince, looksLikePrompt } from '../lib/session-logs.mjs';
import { CatalogStore } from '../lib/store.mjs';
import { sweepSessionLogs } from '../lib/collector.mjs';
import { nfc } from '../lib/paths.mjs';

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
  dir = mkdtempSync(join(tmpdir(), 'a-out-logs-'));
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
