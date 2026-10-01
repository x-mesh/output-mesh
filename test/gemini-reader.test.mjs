import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiReader, parseGeminiTranscriptLine } from '../lib/gemini-reader.mjs';
import { CatalogStore } from '../lib/store.mjs';
import { sweepGemini } from '../lib/collector.mjs';

const SESSION = '123e4567-e89b-42d3-a456-426614174000';
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-reader-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function session(rootName = 'antigravity-cli') {
  const root = join(dir, '.gemini', rootName);
  const sessionDir = join(root, 'brain', SESSION);
  mkdirSync(join(sessionDir, '.system_generated', 'logs'), { recursive: true });
  return { root, sessionDir };
}

function line(value) { return JSON.stringify(value) + '\n'; }

describe('Gemini Antigravity reader', () => {
  test('parses only supported write tools and keeps the first user title', () => {
    const state = { title: null };
    parseGeminiTranscriptLine(line({ type: 'USER_INPUT', content: ' 첫 작업 token=CANARY_SECRET ', created_at: '2026-01-01T00:00:00Z' }).trim(), state);
    parseGeminiTranscriptLine(line({ type: 'USER_INPUT', content: '다음 작업' }).trim(), state);
    const parsed = parseGeminiTranscriptLine(line({ created_at: '2026-01-01T00:01:00Z', tool_calls: [
      { name: 'write_to_file', args: { TargetFile: '/work/a.md', CodeContent: 'secret' } },
      { name: 'replace_file_content', args: { TargetFile: '/work/b.md', ReplacementContent: 'secret' } },
      { name: 'read_file', args: { TargetFile: '/work/no.md' } },
    ] }).trim(), state);
    expect(state.title).toBe('첫 작업 token=[redacted]');
    expect(parsed.records.map((record) => record.path)).toEqual(['/work/a.md', '/work/b.md']);
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(state.title).not.toContain('CANARY_SECRET');
  });

  test('prefers the full transcript and excludes scratch and missing paths', async () => {
    const { root, sessionDir } = session();
    const valid = join(dir, 'repo', 'report.md'); mkdirSync(join(dir, 'repo')); writeFileSync(valid, '# report');
    const scratch = join(root, 'scratch', 'probe.md'); mkdirSync(join(root, 'scratch')); writeFileSync(scratch, 'probe');
    const secret = join(dir, '.env'); writeFileSync(secret, 'TOKEN=secret');
    const logs = join(sessionDir, '.system_generated', 'logs');
    writeFileSync(join(logs, 'transcript.jsonl'), line({ tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/compact-only.md' } }] }));
    writeFileSync(join(logs, 'transcript_full.jsonl'), [
      line({ type: 'USER_INPUT', content: '보고서 작성' }),
      line({ created_at: '2026-01-01T00:00:00Z', tool_calls: [
        { name: 'write_to_file', args: { TargetFile: valid } },
        { name: 'write_to_file', args: { TargetFile: scratch } },
        { name: 'write_to_file', args: { TargetFile: secret } },
        { name: 'write_to_file', args: { TargetFile: join(dir, 'missing.md') } },
      ] }),
    ].join(''));
    const result = await new GeminiReader({ roots: [root] }).scan();
    expect(result.records.map((record) => record.path)).toEqual([valid]);
    expect(result.records[0].title).toBe('보고서 작성');
    expect(result.stats.missing).toBe(1);
  });

  test('collects canonical artifacts and rejects internal derivatives', async () => {
    const { root, sessionDir } = session();
    writeFileSync(join(sessionDir, 'report.md'), '# report');
    writeFileSync(join(sessionDir, '.gitignore'), '*');
    writeFileSync(join(sessionDir, '.env'), 'TOKEN=secret');
    mkdirSync(join(sessionDir, 'artifacts'));
    writeFileSync(join(sessionDir, 'artifacts', 'task.md'), '# task');
    writeFileSync(join(sessionDir, 'artifacts', 'task.md.metadata.json'), '{}');
    writeFileSync(join(sessionDir, 'artifacts', 'task.md.resolved.1'), '# old');
    const records = (await new GeminiReader({ roots: [root] }).scan()).records;
    expect(records.map((record) => record.rel).sort()).toEqual(['artifacts/task.md', 'report.md']);
  });

  test('deduplicates mirrored roots deterministically', async () => {
    const first = session('antigravity'); const second = session('antigravity-ide');
    mkdirSync(join(first.sessionDir, 'artifacts')); mkdirSync(join(second.sessionDir, 'artifacts'));
    writeFileSync(join(first.sessionDir, 'artifacts', 'task.md'), '# same');
    writeFileSync(join(second.sessionDir, 'artifacts', 'task.md'), '# same');
    const records = (await new GeminiReader({ roots: [first.root, second.root] }).scan()).records;
    expect(records).toHaveLength(1);
    expect(records[0].path).toBe(join(second.sessionDir, 'artifacts', 'task.md'));
  });

  test('keeps incomplete lines for the next scan and resets after truncation', async () => {
    const { root, sessionDir } = session();
    const target = join(dir, 'target.md'); writeFileSync(target, '# target');
    const log = join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    const event = line({ tool_calls: [{ name: 'write_to_file', args: { TargetFile: target } }] });
    writeFileSync(log, event.slice(0, -1));
    const reader = new GeminiReader({ roots: [root] });
    expect((await reader.scan()).records).toHaveLength(0);
    writeFileSync(log, event);
    expect((await reader.scan()).records.map((record) => record.path)).toEqual([target]);
    writeFileSync(log, 'broken\n');
    const broken = await reader.scan();
    expect(broken.stats).toMatchObject({ errors: 0, invalidLines: 1 });
    expect(broken.invalid).toEqual([{ path: log, line: 1, reason: 'not-json' }]);
  });

  test('keeps discovered writes after the cursor reaches EOF', async () => {
    const { root, sessionDir } = session();
    const target = join(dir, 'late.md');
    const log = join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    writeFileSync(log, line({ tool_calls: [{ name: 'write_to_file', args: { TargetFile: target } }] }));
    const reader = new GeminiReader({ roots: [root] });
    expect((await reader.scan()).records).toHaveLength(0);
    writeFileSync(target, '# late');
    const second = await reader.scan();
    expect(second.stats.bytes).toBe(0);
    expect(second.records.map((record) => record.path)).toEqual([target]);
  });

  test('advances past an oversized incomplete line', async () => {
    const { root, sessionDir } = session();
    const log = join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    writeFileSync(log, 'x'.repeat(2 * 1024 * 1024));
    const reader = new GeminiReader({ roots: [root] });
    const first = await reader.scan();
    expect(first.stats.errors).toBe(0);
    expect(first.invalid).toEqual([{ path: log, line: 1, reason: 'too-long' }]);
    expect((await reader.scan()).stats.bytes).toBe(0);
  });

  test('skips a broken line once, keeps the other records, and warns instead of failing', async () => {
    const { root, sessionDir } = session();
    const target = join(dir, 'kept.md'); writeFileSync(target, '# kept');
    const log = join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    // 실제 트랜스크립트에서 본 모양: 앞 줄은 온전한 기록이고, 다음 줄이 문장 한가운데에서 시작한다.
    const body = line({ type: 'USER_INPUT', content: '작업' })
      + 'call and its implications for lifetimes"}\n'
      + line({ tool_calls: [{ name: 'write_to_file', args: { TargetFile: target } }] });
    writeFileSync(log, body);
    const store = new CatalogStore(join(dir, 'catalog.db'));
    try {
      const reader = new GeminiReader({ roots: [root] });
      expect(await sweepGemini(store, reader)).toMatchObject({ inserted: 1, errors: 0, invalidLines: 1 });
      // Antigravity 가 파일을 새로 쓰면 처음부터 다시 읽는다. 같은 줄을 다시 알리지 않는다.
      writeFileSync(log, '');
      await reader.scan();
      writeFileSync(log, body);
      expect(await sweepGemini(store, reader)).toMatchObject({ errors: 0, invalidLines: 1 });
      expect(store.db.query("SELECT level, code, path, message FROM ingest_events WHERE code LIKE 'gemini%'").all())
        .toEqual([{ level: 'warn', code: 'gemini_line_skipped', path: log, message: 'Line 2 is not a transcript record (not-json); skipped.' }]);
      expect(store.getState('gemini.last_sweep_code')).toBe('ok');
    } finally { store.close(); }
  });

  test('ignores backup roots and yields during large scans', async () => {
    const active = session();
    const backup = session('antigravity-backup');
    writeFileSync(join(active.sessionDir, 'active.md'), 'active');
    writeFileSync(join(backup.sessionDir, 'backup.md'), 'backup');
    let timerFired = false; setTimeout(() => { timerFired = true; }, 0);
    const result = await new GeminiReader({ home: dir, batchSize: 1 }).scan();
    expect(result.records.map((record) => record.path)).toEqual([join(active.sessionDir, 'active.md')]);
    expect(timerFired).toBe(true);
  });

  test('ingests files once with Gemini provenance and no tool payload', async () => {
    const { root, sessionDir } = session();
    const target = join(dir, 'result.md'); writeFileSync(target, '# result');
    writeFileSync(join(sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl'), [
      line({ type: 'USER_INPUT', content: '결과 작성' }),
      line({ created_at: '2026-01-01T00:00:00Z', tool_calls: [{ name: 'write_to_file', args: { TargetFile: target, CodeContent: 'CANARY_SECRET' } }] }),
    ].join(''));
    const store = new CatalogStore(join(dir, 'catalog.db'));
    try {
      const reader = new GeminiReader({ roots: [root] });
      expect((await sweepGemini(store, reader)).inserted).toBe(1);
      expect((await sweepGemini(store, reader)).inserted).toBe(0);
      expect(store.db.query('SELECT collector, provider, session_ref, session_title, prompt FROM artifact_origins').get()).toEqual({ collector: 'gemini', provider: 'gemini', session_ref: SESSION, session_title: '결과 작성', prompt: null });
      expect(JSON.stringify(store.db.query('SELECT * FROM artifact_origins').all())).not.toContain('CANARY_SECRET');
    } finally { store.close(); }
  });
});
