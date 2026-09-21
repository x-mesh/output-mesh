import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { AsideReader } from '../lib/aside-reader.mjs';
import { collectOnce } from '../lib/collector.mjs';
import { startServer } from '../lib/server.mjs';
import { nfc } from '../lib/paths.mjs';

const PORT = 19857;
const base = `http://127.0.0.1:${PORT}`;

let dir;
let store;
let server;
let htmlId;

const get = (path) => fetch(base + path);
const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'a-out-server-'));
  const artifactsDir = join(dir, 'u0', 'sessions', '2026-01-01_SRVTEST', 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, 'sketch.html'), '<html><body><h1>스케치</h1><script>var x=1</script></body></html>');
  writeFileSync(join(artifactsDir, 'note.md'), '한글 본문 텍스트');
  writeFileSync(join(artifactsDir, 'App.swift'), 'struct App {}');
  writeFileSync(join(dir, 'secret.txt'), 'TOP SECRET');

  store = new CatalogStore(join(dir, 'c.db'));
  const reader = new AsideReader(join(dir, 'u0'));
  await collectOnce(store, reader);
  htmlId = store.byPathKey(nfc(join(artifactsDir, 'sketch.html'))).id;
  server = await startServer({ store, watcher: null, readers: [reader] }, { port: PORT });
});

afterAll(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('V7 — 아티팩트 서빙 자세', () => {
  test('CSP 로 외부 연결과 폼 전송을 차단한다', async () => {
    const csp = (await get(`/artifact/${htmlId}/raw`)).headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test('기본은 스크립트 차단이고, 허용해도 connect-src 는 열리지 않는다', async () => {
    expect((await get(`/artifact/${htmlId}/raw`)).headers.get('content-security-policy')).toContain("script-src 'none'");

    await post(`/api/artifact/${htmlId}/allow-scripts`, { on: true });
    const after = (await get(`/artifact/${htmlId}/raw`)).headers.get('content-security-policy');
    expect(after).toContain("script-src 'unsafe-inline'");
    expect(after).toContain("connect-src 'none'");

    await post(`/api/artifact/${htmlId}/allow-scripts`, { on: false });
  });

  test('MIME 스니핑을 막는다', async () => {
    expect((await get(`/artifact/${htmlId}/raw`)).headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('V7 — 경로 탈출', () => {
  test.each([
    '/artifact/999999/raw',
    '/artifact/0/raw',
    '/../lib/store.mjs',
    '/../../etc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',
  ])('%s 는 파일을 내주지 않는다', async (path) => {
    const res = await get(path);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('카탈로그에 없는 파일은 어떤 경로로도 나오지 않는다', async () => {
    const res = await get('/secret.txt');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('TOP SECRET');
  });

  test('홈 디렉터리 밖 탐색은 거부된다', async () => {
    expect((await get('/api/browse?path=/etc')).status).toBe(400);
  });
});

describe('API', () => {
  test('검색이 한글 질의에 응답한다', async () => {
    const { rows } = await (await get('/api/search?q=' + encodeURIComponent('본문'))).json();
    expect(rows.map((r) => r.file_name)).toContain('note.md');
  });

  test('상세에 출처와 미리보기 종류가 담긴다', async () => {
    const detail = await (await get(`/api/artifact/${htmlId}`)).json();
    expect(detail).toMatchObject({ kind: 'markup', collector: 'aside', file_name: 'sketch.html' });
  });

  test('목록 행과 상세가 같은 규칙으로 부제·위치를 싣는다', async () => {
    const { rows } = await (await get('/api/search?view=library')).json();
    const sketch = rows.find((r) => r.file_name === 'sketch.html');
    expect(sketch).toMatchObject({ subtitle: '스케치', subtitle_source: 'doc', location: null });
    const detail = await (await get(`/api/artifact/${htmlId}`)).json();
    expect([detail.subtitle, detail.subtitle_source]).toEqual([sketch.subtitle, sketch.subtitle_source]);
  });

  test('현황 숫자가 라이브러리 목록 건수와 같다', async () => {
    const numbers = await (await get('/api/overview')).json();
    const list = await (await get('/api/search?view=library')).json();
    expect(numbers.library).toBe(list.total);
  });

  test('목록 상한은 요청할 수 있지만 잘못된 값은 기본값으로 돌아간다', async () => {
    expect((await (await get('/api/search?limit=1')).json()).rows).toHaveLength(1);
    const fallback = await (await get('/api/search?limit=-5')).json();
    expect(fallback.rows.length).toBe(fallback.total);
  });

  test('시트 미리보기는 스프레드시트만 받는다 — 경로는 DB 에서만 온다', async () => {
    expect((await get(`/api/artifact/${htmlId}/sheet`)).status).toBe(422);
    expect((await get('/api/artifact/999999/sheet')).status).toBe(404);
  });

  test('화면이 쓰는 버전은 package.json 과 같다', async () => {
    const { VERSION } = await import('../lib/version.mjs');
    expect(await (await get('/api/version')).json()).toEqual({ name: 'output-mesh', version: VERSION });
  });

  test('태그를 붙이면 즉시 검색된다', async () => {
    await post(`/api/artifact/${htmlId}/tag`, { name: '데모' });
    const { rows } = await (await get('/api/search?q=' + encodeURIComponent('데모'))).json();
    expect(rows.map((r) => r.file_name)).toContain('sketch.html');
  });

  test('최종본 토글이 잠금과 함께 저장된다', async () => {
    const detail = await (await post(`/api/artifact/${htmlId}/state`, { state: 'final' })).json();
    expect(detail.state).toBe('final');
    expect(store.byPathKey(detail.path_key).state_locked).toBe(1);
  });

  test('/api/facets 가 목록과 같은 필터를 받는다 — 서버가 파라미터를 흘리던 실패', async () => {
    const facets = await (await get('/api/facets?view=library')).json();
    const list = await (await get('/api/search?view=library')).json();
    expect(facets.states.reduce((sum, row) => sum + row.n, 0)).toBe(list.total);
    expect(facets.exts.map((e) => e.value)).not.toContain('swift');
  });

  test('/api/facets 가 검색어도 받는다 — 결과는 1건인데 사이드바가 전체 건수를 광고하던 실패', async () => {
    const q = encodeURIComponent('본문');
    const facets = await (await get(`/api/facets?view=library&q=${q}`)).json();
    const list = await (await get(`/api/search?view=library&q=${q}`)).json();
    expect(facets.states.reduce((sum, row) => sum + row.n, 0)).toBe(list.total);
    expect(facets.exts.map((e) => e.value)).toEqual(['md']);
  });

  test('정적 파일은 캐시되지 않는다 — 편집한 UI 가 새로고침에 안 바뀌던 원인', async () => {
    const res = await get('/app.js');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await get('/style.css')).status).toBe(200);
  });

  test('없는 아티팩트는 404 다', async () => {
    expect((await get('/api/artifact/424242')).status).toBe(404);
  });
});
