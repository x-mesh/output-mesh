import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { AsideReader } from '../lib/aside-reader.mjs';
import { collectOnce } from '../lib/collector.mjs';
import { startServer } from '../lib/server.mjs';
import { MAX_DRAWIO_BYTES, MAX_PREVIEW_BYTES, nfc } from '../lib/paths.mjs';

const PORT = 19857;
const base = `http://127.0.0.1:${PORT}`;

let dir;
let store;
let server;
let htmlId;
let drawioId;
let bigDrawioId;
let bundleId;

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
  // 2MB 를 넘지만 drawio 상한 안. 텍스트 상한을 그대로 쓰면 여기서 413 이 난다.
  writeFileSync(join(artifactsDir, 'big.drawio'),
    '<mxfile><diagram><mxGraphModel><root>'
    + '<mxCell id="1" value="큰 도형" style="shape=image"/>'.repeat(40000)
    + '</root></mxGraphModel></diagram></mxfile>');
  writeFileSync(join(artifactsDir, 'flow.drawio'),
    '<mxfile><diagram name="main"><mxGraphModel><root>'
    + '<mxCell id="2" value="&lt;b&gt;결제 서버&lt;/b&gt;" style="shape=image;image=img/lib/mscae/API_Management.svg"/>'
    + '</root></mxGraphModel></diagram></mxfile>');
  const bundleDir = join(artifactsDir, 'rack-mesh-drawio-spaces');
  mkdirSync(join(bundleDir, 'inner'), { recursive: true });
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(bundleDir, `IN-${i}.drawio`), `<mxfile><diagram><mxGraphModel><root><mxCell value="망 ${i}"/></root></mxGraphModel></diagram></mxfile>`);
  }
  writeFileSync(join(bundleDir, 'inner', 'note.md'), '구성 파일 안의 문서');
  writeFileSync(join(dir, 'secret.txt'), 'TOP SECRET');

  store = new CatalogStore(join(dir, 'c.db'));
  const reader = new AsideReader(join(dir, 'u0'));
  await collectOnce(store, reader);
  htmlId = store.byPathKey(nfc(join(artifactsDir, 'sketch.html'))).id;
  drawioId = store.byPathKey(nfc(join(artifactsDir, 'flow.drawio'))).id;
  bigDrawioId = store.byPathKey(nfc(join(artifactsDir, 'big.drawio'))).id;
  bundleId = store.byPathKey(nfc(bundleDir)).id;
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

describe('drawio 는 읽기 전용 뷰어로 그린다', () => {
  test('뷰어 페이지는 도형 XML 과 프레임 스크립트를 함께 준다', async () => {
    const res = await get(`/artifact/${drawioId}/drawio`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('/drawio-frame.js');
    expect(body).toContain('mxGraphModel');
  });

  test('도형 아이콘만 바깥에서 받는다 — 스크립트가 부를 길은 닫아 둔다', async () => {
    const csp = (await get(`/artifact/${drawioId}/drawio`)).headers.get('content-security-policy');
    expect(csp).toContain('img-src data: https:');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
  });

  test('drawio 서버의 상대경로 도형은 원래 자리로 돌린다 — 우리 주소에서는 404 다', async () => {
    const body = await (await get(`/artifact/${drawioId}/drawio`)).text();
    expect(body).toContain('https://app.diagrams.net/img/lib/mscae/API_Management.svg');
    expect(body).not.toContain('image=img/lib/');
  });

  test("스크립트 출처를 'self' 가 아니라 실제 주소로 적는다 — 샌드박스 오리진은 불투명하다", async () => {
    const csp = (await get(`/artifact/${drawioId}/drawio`)).headers.get('content-security-policy');
    expect(csp).toContain(`script-src ${base}`);
    expect(csp).not.toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
  });

  test('2MB 를 넘어도 그린다 — 실측 306개 중 5개가 텍스트 상한 바로 위에 있다', async () => {
    const size = store.db.query('SELECT size_bytes n FROM artifacts WHERE id = ?').get(bigDrawioId).n;
    expect(size).toBeGreaterThan(MAX_PREVIEW_BYTES);
    expect(size).toBeLessThan(MAX_DRAWIO_BYTES);
    expect((await get(`/artifact/${bigDrawioId}/drawio`)).status).toBe(200);
  });

  test('drawio 가 아닌 아티팩트에는 뷰어를 내주지 않는다', async () => {
    expect((await get(`/artifact/${htmlId}/drawio`)).status).toBe(404);
  });

  test('도형 이름이 본문으로 색인돼 검색에 걸린다', () => {
    const doc = store.db.query('SELECT body, body_state FROM search_docs WHERE artifact_id = ?').get(drawioId);
    expect(doc.body_state).toBe('indexed');
    expect(doc.body).toBe('결제 서버');
  });
});

describe('접힌 번들의 구성 파일을 연다', () => {
  test('상세가 구성 파일마다 종류와 확장자를 함께 준다', async () => {
    const detail = await (await get(`/api/artifact/${bundleId}`)).json();
    expect(detail.bundle_files).toBe(13);
    expect(detail.members).toContainEqual({ path: 'IN-0.drawio', ext: 'drawio', kind: 'markup' });
    expect(detail.members).toContainEqual({ path: 'inner/note.md', ext: 'md', kind: 'text' });
  });

  test('구성 파일의 본문과 도형을 그대로 내준다', async () => {
    const raw = await get(`/artifact/${bundleId}/raw?path=${encodeURIComponent('inner/note.md')}`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe('구성 파일 안의 문서');

    const view = await get(`/artifact/${bundleId}/drawio?path=${encodeURIComponent('IN-3.drawio')}`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain('망 3');
  });

  test('구성 목록에 없는 이름은 거부한다 — 클라이언트 문자열이 경로가 되지 않는다', async () => {
    for (const bad of ['../../../secret.txt', '../secret.txt', 'IN-0.drawio/../../secret.txt', 'nope.drawio']) {
      expect((await get(`/artifact/${bundleId}/raw?path=${encodeURIComponent(bad)}`)).status).toBe(404);
    }
  });

  test('번들이 아닌 아티팩트에는 구성 파일이 없다', async () => {
    expect((await get(`/artifact/${htmlId}/raw?path=${encodeURIComponent('note.md')}`)).status).toBe(404);
  });
});
