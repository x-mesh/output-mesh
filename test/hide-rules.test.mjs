import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { ingestFile } from '../lib/collector.mjs';
import { facets, hideRuleCounts, search } from '../lib/search.mjs';
import { normalizeRule } from '../lib/hide-rules.mjs';

let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'output-mesh-rules-'));
  store = new CatalogStore(join(dir, 'c.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = async (...parts) => {
  const path = join(dir, ...parts);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `# ${parts.join('/')}`);
  await ingestFile(store, path, { collector: 'codex', provider: 'openai-codex', sessionRef: 's1', workspace: dir });
  return path;
};
const names = (filters = {}) => search(store, '', { view: 'library', ...filters }).map((row) => row.file_name).sort();
const rule = (pattern) => store.hideRules().find((r) => r.pattern === pattern);

describe('숨김 규칙', () => {
  test('기본 규칙이 깔리고, 끈 규칙은 다시 시작해도 켜지지 않는다', () => {
    expect(store.hideRules().filter((r) => r.enabled).map((r) => r.pattern).sort()).toEqual(['Pods', 'site-packages', 'third_party', 'vendor']);
    expect(rule('.xm').enabled).toBe(0);
    store.setHideRuleEnabled(rule('vendor').id, false);
    store.close();
    store = new CatalogStore(join(dir, 'c.db'));
    expect(rule('vendor').enabled).toBe(0);
    expect(store.hideRules().length).toBe(6);
  });

  test('폴더 이름이 정확히 같을 때만 숨긴다 — 이름이 들어간 파일 · 비슷한 폴더는 그대로', async () => {
    await add('repo', 'src', 'a.md');
    await add('repo', 'vendor', 'lib', 'b.md');
    await add('repo', 'vendor-notes.md');
    await add('repo', 'vendors', 'c.md');
    await add('repo', 'docs', 'vendor.md');
    expect(names()).toEqual(['a.md', 'c.md', 'vendor-notes.md', 'vendor.md']);
  });

  test('규칙을 끄면 바로 돌아오고, 숨긴 수는 켜진 규칙의 보이는 만큼이다', async () => {
    await add('r', 'vendor', 'x.md');
    await add('r', 'vendor', 'y.md');
    await add('r', 'third_party', 'z.md');
    expect(names()).toEqual([]);
    const counts = hideRuleCounts(store, '', { view: 'library' });
    expect(counts.total).toBe(3);
    expect(Object.fromEntries(counts.rules.map((c) => [store.hideRules().find((r) => r.id === c.id).pattern, c.n]))).toMatchObject({ vendor: 2, third_party: 1 });
    expect(facets(store, { view: 'library' }).hiddenRules.total).toBe(3);

    store.setHideRuleEnabled(rule('vendor').id, false);
    expect(names()).toEqual(['x.md', 'y.md']);
    expect(hideRuleCounts(store, '', { view: 'library' }).total).toBe(1);
  });

  test('사람이 손댔거나 산출물로 표시된 파일은 규칙이 있어도 남는다', async () => {
    const fav = await add('r', 'vendor', 'fav.md');
    const tagged = await add('r', 'vendor', 'tagged.md');
    const noted = await add('r', 'vendor', 'noted.md');
    const final = await add('r', 'vendor', 'final.md');
    await add('r', 'vendor', 'plain.md');
    store.setFavorite(store.byPathKey(fav).id, true);
    store.addTag(store.byPathKey(tagged).id, 'keep');
    store.setNote(store.byPathKey(noted).id, '중요');
    store.setUserState(store.byPathKey(final).id, 'final');
    expect(names()).toEqual(['fav.md', 'final.md', 'noted.md', 'tagged.md']);
    expect(hideRuleCounts(store, '', { view: 'library' }).total).toBe(1);
  });

  test('경로 규칙은 그 폴더 아래만 숨긴다', async () => {
    await add('repo', 'legacy', 'a.md');
    await add('repo', 'legacy2', 'b.md');
    store.addHideRule({ kind: 'path', pattern: join(dir, 'repo', 'legacy') });
    expect(names()).toEqual(['b.md']);
  });

  test('이름의 % · _ 는 글자 그대로다', async () => {
    await add('r', 'a_b', 'x.md');
    await add('r', 'axb', 'y.md');
    store.addHideRule({ kind: 'folder', pattern: 'a_b' });
    expect(names()).toEqual(['y.md']);
  });

  test('기본 규칙은 지우지 못하고 사용자 규칙은 지운다. 못 쓰는 값은 거절한다', () => {
    expect(store.deleteHideRule(rule('vendor').id)).toBe(false);
    const id = store.addHideRule({ kind: 'folder', pattern: 'legacy' });
    expect(store.deleteHideRule(id)).toBe(true);
    for (const bad of [{ kind: 'folder', pattern: 'a/b' }, { kind: 'folder', pattern: '' }, { kind: 'path', pattern: 'relative/x' }, { kind: 'path', pattern: '/a/../b' }, { kind: 'x', pattern: 'a' }]) {
      expect(() => normalizeRule(bad)).toThrow();
    }
    expect(normalizeRule({ kind: 'path', pattern: '/a/b///' })).toEqual({ kind: 'path', pattern: '/a/b' });
  });
});
