import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { ingestFile, recheckKnownFiles } from '../lib/collector.mjs';
import { recentChanges } from '../lib/search.mjs';
import { Watcher } from '../lib/watcher.mjs';
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

    const changes = recentChanges(store, '', { view: 'library' });
    expect(changes.map((c) => [c.file_name, c.change])).toEqual([['guide.md', 'missing'], ['guide.md', 'created']]);
    expect(changes[0].location).toMatchObject({ dir: '/' });
  });

  test('오래된 기록은 지운다', async () => {
    const path = join(dir, 'old.md');
    writeFileSync(path, 'x');
    await ingestFile(store, path, codex);
    store.pruneEvents(Math.floor(Date.now() / 1000) + 1);
    expect(events()).toEqual([]);
  });
});
