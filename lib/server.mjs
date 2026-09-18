import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_SEARCH_LIMIT, MAX_PREVIEW_BYTES, MAX_SEARCH_LIMIT, nfc } from './paths.mjs';
import { activity, describeArtifact, facets, overview, periodStart, search, searchCount, timeline } from './search.mjs';
import { sourcesStatus } from './sources.mjs';
import { mimeFor, artifactCsp } from './mime.mjs';
import { importPath } from './importer.mjs';
import { surveyCoverage } from './coverage.mjs';
import { readSheets } from './sheet.mjs';
import { KIND } from './extract.mjs';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HOME = homedir();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function serveStatic(res, pathname, headOnly = false) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // 정적 경로는 public/ 안으로만 해석한다. resolve 후 접두사 재검사로 경로 탈출을 막는다.
  const target = resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + '/') && target !== join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end(headOnly ? undefined : 'forbidden');
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end(headOnly ? undefined : 'not found');
    return;
  }
  const ext = target.split('.').pop().toLowerCase();
  res.writeHead(200, {
    'content-type': mimeFor(ext),
    'x-content-type-options': 'nosniff',
    // 로컬 단일 사용자. 검증자 없이 캐시되면 편집한 UI 가 새로고침에도 안 바뀐다.
    'cache-control': 'no-store',
  });
  res.end(headOnly ? undefined : readFileSync(target));
}

/** 목록과 사이드바가 같은 범위를 보도록 파라미터 해석을 한 곳에 둔다. */
function filtersFrom(url) {
  const pick = (name) => url.searchParams.get(name) || undefined;
  return {
    provider: pick('provider'),
    state: pick('state'),
    ext: pick('ext'),
    kind: pick('kind'),
    workspace: pick('workspace'),
    collector: pick('collector'),
    tag: pick('tag'),
    view: pick('view'),
    favorite: url.searchParams.get('favorite') === '1',
    includeMissing: url.searchParams.get('missing') === '1',
    // 시작 시각은 서버가 정한다. 클라이언트가 시각을 보내면 현황 숫자와 목록이 다른 자정을 쓸 수 있다.
    since: periodStart(url.searchParams.get('period')) ?? undefined,
  };
}

function integerParam(url, name) {
  const value = Number(url.searchParams.get(name));
  return url.searchParams.has(name) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function artifactDetail(store, id) {
  const row = store.db
    .query(
      `SELECT a.*, d.body_state
       FROM artifacts a LEFT JOIN search_docs d ON d.artifact_id = a.id
       WHERE a.id = ?`,
    )
    .get(id);
  if (!row) return null;

  const origins = store.originsOf(id);
  const primary = origins[0] ?? {};
  const providers = [...new Set(origins.map((o) => o.provider).filter(Boolean))].sort();
  const times = origins.map((o) => o.occurred_at).filter((t) => t != null);
  const duplicates = row.content_hash
    ? store.db
        .query('SELECT id, file_name, abs_path FROM artifacts WHERE content_hash = ? AND id <> ?')
        .all(row.content_hash, id)
    : [];
  const members = row.bundle_files
    ? (store.db.query('SELECT body FROM search_docs WHERE artifact_id = ?').get(id)?.body ?? '').split('\n').filter(Boolean).slice(0, 200)
    : undefined;
  return {
    ...row,
    // 대표 출처를 예전과 같은 키로 평면화한다. 화면과 기존 테스트가 그대로 산다.
    collector: primary.collector ?? null,
    provider: primary.provider ?? null,
    session_ref: primary.session_ref || null,
    turn_ref: primary.turn_ref ?? null,
    session_title: primary.session_title ?? null,
    prompt: primary.prompt ?? null,
    session_dir: primary.session_dir ?? null,
    workspace: primary.workspace ?? null,
    // 생성은 가장 이른 출처, 산출물 표시는 어느 출처든 하나라도 — 컬럼마다 접는 규칙이 다르다.
    created_at: times.length ? Math.min(...times) : null,
    is_deliverable: origins.some((o) => o.is_deliverable === 1) ? 1 : 0,
    providers,
    origin_count: origins.length,
    origins,
    members,
    kind: row.kind,
    tags: store.tagsOf(id),
    duplicates,
    stale_final: row.state === 'final' && row.final_hash !== null && row.final_hash !== row.content_hash,
    ...describeArtifact(store, id),
  };
}

/** 홈 디렉터리 밖은 열람하지 않는다. 심볼릭 링크 해석 후 다시 검사한다. */
function browse(dirPath) {
  const target = resolve(dirPath || HOME);
  const real = existsSync(target) ? realpathSync(target) : target;
  if (real !== HOME && !real.startsWith(HOME + '/')) throw new Error('홈 디렉터리 밖은 열 수 없습니다');
  if (!existsSync(real) || !statSync(real).isDirectory()) throw new Error('디렉터리가 아닙니다');
  const entries = readdirSync(real, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: join(real, e.name), dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { path: real, parent: real === HOME ? null : dirname(real), entries };
}

const SSE_HEARTBEAT_MS = 25_000;

export function createCatalogServer({ store, watcher, readers }) {
  const clients = new Set();
  watcher?.onCollect((payload) => {
    for (const client of clients) {
      try {
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/api/search') {
        const filters = filtersFrom(url);
        const query = url.searchParams.get('q') ?? '';
        const limit = Math.min(integerParam(url, 'limit') ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        const rows = search(store, query, filters, limit);
        return json(res, 200, {
          total: searchCount(store, query, filters),
          rows,
        });
      }

      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello', counts: store.counts() })}\n\n`);
        clients.add(res);
        // 프록시나 유휴 타임아웃이 조용히 끊는 걸 막는다.
        const beat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
        const stop = () => {
          clearInterval(beat);
          clients.delete(res);
        };
        req.on('close', stop);
        req.on('error', stop);
        return undefined;
      }

      if (req.method === 'GET' && path === '/api/facets') return json(res, 200, facets(store, filtersFrom(url)));
      if (req.method === 'GET' && path === '/api/overview') return json(res, 200, overview(store));
      if (req.method === 'GET' && path === '/api/timeline') {
        return json(res, 200, timeline(store, url.searchParams.get('q') ?? '', filtersFrom(url), url.searchParams.get('period') ?? 'all'));
      }

      if (req.method === 'GET' && path === '/api/activity') {
        return json(res, 200, {
          sessions: activity(store, {
            collector: url.searchParams.get('collector') || undefined,
            workspace: url.searchParams.get('workspace') || undefined,
            since: periodStart(url.searchParams.get('period')) ?? undefined,
          }),
        });
      }

      if (req.method === 'GET' && path === '/api/coverage') {
        return json(res, 200, {
          sources: readers.map((reader) => ({
            sessionsRoot: reader.sessionsRoot,
            ...surveyCoverage(reader.sessionsRoot),
          })),
          counts: store.counts(),
          events: store.recentIngestEvents(10),
        });
      }

      if (req.method === 'GET' && path === '/api/status') {
        return json(res, 200, {
          counts: store.counts(),
          watcher: watcher?.status() ?? null,
          sources: sourcesStatus(store, readers),
          events: store.recentIngestEvents(20),
          duplicates: store.duplicateGroups(),
        });
      }

      const detailMatch = path.match(/^\/api\/artifact\/(\d+)$/);
      if (req.method === 'GET' && detailMatch) {
        const detail = artifactDetail(store, Number(detailMatch[1]));
        return detail ? json(res, 200, detail) : json(res, 404, { error: 'not found' });
      }

      // 경로는 DB 에서만 온다. 클라이언트가 준 문자열이 unzip 인자에 닿지 않는다.
      const sheetMatch = path.match(/^\/api\/artifact\/(\d+)\/sheet$/);
      if (req.method === 'GET' && sheetMatch) {
        const row = store.db.query('SELECT abs_path, kind, missing_at FROM artifacts WHERE id = ?').get(Number(sheetMatch[1]));
        if (!row) return json(res, 404, { error: 'not found' });
        if (row.kind !== KIND.SHEET || row.missing_at !== null) return json(res, 422, { error: 'not a readable spreadsheet' });
        return json(res, 200, await readSheets(row.abs_path));
      }

      const mutateMatch = path.match(/^\/api\/artifact\/(\d+)\/(tag|untag|state|favorite|note|allow-scripts|reveal)$/);
      if (req.method === 'POST' && mutateMatch) {
        const id = Number(mutateMatch[1]);
        const body = await readJsonBody(req);
        const row = store.db.query('SELECT abs_path FROM artifacts WHERE id = ?').get(id);
        if (row) row.session_dir = store.originsOf(id).find((o) => o.session_dir)?.session_dir ?? null;
        if (!row) return json(res, 404, { error: 'not found' });
        switch (mutateMatch[2]) {
          case 'tag': store.addTag(id, String(body.name ?? '').trim()); break;
          case 'untag': store.removeTag(id, String(body.name ?? '')); break;
          case 'state': store.setUserState(id, String(body.state)); break;
          case 'favorite': store.setFavorite(id, Boolean(body.on)); break;
          case 'note': store.setNote(id, body.note ?? null); break;
          case 'allow-scripts': store.setAllowScripts(id, Boolean(body.on)); break;
          case 'reveal': {
            const target = body.session ? row.session_dir : row.abs_path;
            if (target) Bun.spawn(['/usr/bin/open', '-R', target], { stdout: 'ignore', stderr: 'ignore' });
            break;
          }
        }
        const { reindexArtifact } = await import('./collector.mjs');
        await reindexArtifact(store, id);
        return json(res, 200, artifactDetail(store, id));
      }

      const rawMatch = path.match(/^\/artifact\/(\d+)\/raw$/);
      if (req.method === 'GET' && rawMatch) {
        // 파일 경로는 오직 DB 에서만 온다. 클라이언트 문자열이 파일시스템에 닿는 경로가 없다.
        const row = store.db.query('SELECT abs_path, ext, kind, allow_scripts, size_bytes FROM artifacts WHERE id = ?').get(Number(rawMatch[1]));
        if (!row || !existsSync(row.abs_path)) return json(res, 404, { error: 'not found' });
        const kind = row.kind;
        if (kind !== 'image' && kind !== 'pdf' && row.size_bytes > MAX_PREVIEW_BYTES) {
          return json(res, 413, { error: 'too large to preview' });
        }
        res.writeHead(200, {
          'content-type': mimeFor(row.ext),
          'content-security-policy': artifactCsp(row.allow_scripts === 1),
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
        });
        return res.end(readFileSync(row.abs_path));
      }

      if (req.method === 'GET' && path === '/api/browse') {
        try {
          return json(res, 200, browse(url.searchParams.get('path')));
        } catch (error) {
          return json(res, 400, { error: String(error.message ?? error) });
        }
      }

      if (req.method === 'POST' && path === '/api/import') {
        const body = await readJsonBody(req);
        try {
          return json(res, 200, await importPath(store, nfc(String(body.path ?? ''))));
        } catch (error) {
          return json(res, 400, { error: String(error.message ?? error) });
        }
      }

      if (req.method === 'POST' && path === '/api/sweep') {
        const result = await watcher?.collect();
        return json(res, 200, { result, counts: store.counts() });
      }

      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, path, req.method === 'HEAD');
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      return json(res, 500, { error: String(error.message ?? error) });
    }
  });
}

export function startServer(options, { port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const server = createCatalogServer(options);
  return new Promise((resolvePromise) => server.listen(port, host, () => resolvePromise(server)));
}
