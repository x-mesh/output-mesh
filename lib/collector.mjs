import { readdirSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { BUILD_ARTIFACT_DIRS, BUNDLE_MIN_FILES, COLLECT_YIELD_MS, FEED_BACKLOG_S, MAX_BUNDLE_MEMBERS, PROJECT_MARKERS, SESSION_TITLE_MAX_CHARS, WORKSPACE_SCAN_MAX_DEPTH, WORKSPACE_SCAN_MAX_FILES, nfc } from './paths.mjs';
import { WORKSPACE_COLLECTOR, isWorkspaceDoc } from './workspace-docs.mjs';
import { COLLECTIBLE_SUBDIRS } from './paths.mjs';
import { classifyFilesChangedPath, extOf, isCollectibleDir, splitSessionDirName } from './scanner.mjs';
import { fileIdOf, hashFile, HASH_UNSTABLE } from './hash.mjs';
import { BODY_STATE, extractBody } from './extract.mjs';
import { SESSION_LOG_PARSER_VERSION, SESSION_LOG_SOURCES, logFilesSince, newLogTail } from './session-logs.mjs';
import { nowSeconds } from './store.mjs';
import { titleFromPrompt } from './describe.mjs';
import { CursorReader } from './cursor-reader.mjs';
import { resolveWorkspace } from './worktrees.mjs';

function collectibleDirs(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return [];
  const out = [];
  for (const session of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const artifactsDir = join(sessionsRoot, session.name, 'artifacts');
    if (!existsSync(artifactsDir)) continue;
    for (const dir of [artifactsDir, ...subCollectibles(sessionsRoot, artifactsDir)]) {
      if (isCollectibleDir(relative(sessionsRoot, dir))) out.push(dir);
    }
  }
  return out;
}

function subCollectibles(sessionsRoot, artifactsDir) {
  const out = [];
  for (const entry of readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = join(artifactsDir, entry.name);
    if (isCollectibleDir(relative(sessionsRoot, dir))) out.push(dir);
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // 심볼릭 링크는 해석하지 않는다. 링크 하나가 임의의 트리를 끌어와 경로 정체성을 깬다.
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

/**
 * 변경을 피드에 남긴다. 에이전트 기록으로 본 변화는 로그가 일어난 때를 알려주므로 알아챈 때가 아니라
 * 그때로 적고, 너무 오래된 것은 남기지 않는다 — 방금 일어난 일이 아니라 원래 있던 것을 뒤늦게 안
 * 것이다. 파일과 출처는 그대로 들어가서 라이브러리와 활동 보기에는 실제 시각으로 보인다.
 * 세션이 없는 출처(저장소 문서, 다시 확인)는 누가 언제 바꿨는지 모르므로 지금으로 남긴다.
 */
function recordChange(store, id, kind, origin) {
  const now = nowSeconds();
  const happenedAt = origin?.sessionRef && Number.isFinite(origin.createdAt) ? Math.min(origin.createdAt, now) : now;
  if (now - happenedAt > FEED_BACKLOG_S) return;
  store.recordEvent(id, kind, { origin, at: happenedAt });
}

/**
 * 아티팩트 하나를 반영한다. 반환값은 적용한 정체성 규칙.
 *   touched   경로·해시 동일
 *   updated   제자리 편집 (태그 보존)
 *   relocated 이름 변경 (inode 로 추적, 태그 보존)
 *   inserted  신규
 */
export async function ingestFile(store, absPath, origin) {
  const pathKey = nfc(absPath);
  const stat = statSync(absPath);
  if (stat.size === 0) return { rule: 'skipped-empty' };

  const { hash, skipped } = await hashFile(absPath);
  if (skipped === HASH_UNSTABLE) {
    store.logIngest({ path: absPath, level: 'warn', code: 'hash_unstable', message: '쓰는 중으로 보여 다음 스윕으로 미룸' });
    return { rule: 'skipped-unstable' };
  }
  if (skipped) store.logIngest({ path: absPath, level: 'warn', code: 'hash_too_large', message: `${stat.size} bytes` });

  const mtime = Math.floor(stat.mtimeMs / 1000);
  const fileId = fileIdOf(stat);
  const fileName = nfc(absPath.split('/').pop());

  // 변경 기록은 규칙이 정해지는 이 자리에서만 남긴다. 호출하는 곳(스윕, 세션 로그, 가져오기,
  // 다시 확인)마다 남기면 규칙이 갈라진다. 내용이 그대로인 'touched' 는 기록하지 않는다 —
  // 30초마다 모든 파일이 이 길을 지나서, 남기면 피드가 변화 아닌 것으로 뒤덮인다.
  const existing = store.byPathKey(pathKey);
  if (existing) {
    const wasMissing = existing.missing_at !== null;
    if (existing.content_hash === hash && hash !== null) {
      store.touchArtifact(existing.id, { mtime, sizeBytes: stat.size });
      // 내용이 그대로여도 다른 세션이 이 파일을 건드린 사실은 출처 한 줄로 남는다.
      // 1:1 시절에는 여기서 앞 세션을 덮어써 출처가 섞였다.
      if (origin) store.recordOrigin(existing.id, origin);
      if (wasMissing) recordChange(store, existing.id, 'restored', origin);
      return { id: existing.id, rule: 'touched' };
    }
    store.updateContent(existing.id, { contentHash: hash, sizeBytes: stat.size, mtime, fileId });
    if (origin) store.recordOrigin(existing.id, origin);
    recordChange(store, existing.id, wasMissing ? 'restored' : 'modified', origin);
    return { id: existing.id, rule: 'updated' };
  }

  const renamed = store.missingByFileId(fileId);
  if (renamed) {
    store.relocate(renamed.id, { pathKey, absPath, fileName, mtime, sizeBytes: stat.size });
    store.updateContent(renamed.id, { contentHash: hash, sizeBytes: stat.size, mtime, fileId });
    if (origin) store.recordOrigin(renamed.id, origin);
    recordChange(store, renamed.id, 'moved', origin);
    return { id: renamed.id, rule: 'relocated' };
  }

  const id = store.insertArtifact({
    pathKey,
    absPath,
    fileName,
    ext: extOf(fileName),
    sizeBytes: stat.size,
    contentHash: hash,
    fileId,
    mtime,
    discoveredAt: nowSeconds(),
  });
  if (origin) store.recordOrigin(id, origin);
  recordChange(store, id, 'created', origin);
  return { id, rule: 'inserted' };
}

/**
 * 세션 로그로 찾은 파일은 저장소 안에 그대로 있다. 로그는 에이전트가 쓴 순간만 알려주므로, 그 뒤에
 * 사람이 고치거나 지운 것은 여기서 잡는다. 크기와 수정 시각이 그대로면 해시하지 않는다 — 1,300개를
 * 30초마다 다 읽으면 서버가 무거워진다.
 *
 * Aside 출처 파일은 sweep 이 대조하므로 빼 둔다. 둘이 같은 파일을 판정하면 수집 범위 밖으로 옮겨진
 * 파일(디스크에는 있음)을 한쪽은 사라짐, 한쪽은 돌아옴으로 번갈아 적는다.
 */
export async function recheckKnownFiles(store, { onProgress } = {}) {
  const rows = store.db
    .query(`SELECT a.id, a.abs_path, a.size_bytes, a.mtime, a.missing_at, a.bundle_files FROM artifacts a
            WHERE NOT EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = a.id AND o.collector = 'aside')`)
    .all();
  const stats = { checked: rows.length, modified: 0, missing: 0, restored: 0 };
  const gone = [];
  const pause = yielder();
  for (const [done, row] of rows.entries()) {
    await pause();
    onProgress?.({ step: 'recheck', done, total: rows.length });
    let stat = null;
    try {
      stat = statSync(row.abs_path);
    } catch {
      // 없어졌거나 권한이 사라졌다. 어느 쪽이든 지금은 읽을 수 없는 원본이다.
    }
    if (!stat) {
      if (row.missing_at === null) gone.push(row.id);
      continue;
    }
    if (row.bundle_files !== null || !stat.isFile()) continue;
    const same = row.missing_at === null && stat.size === row.size_bytes && Math.floor(stat.mtimeMs / 1000) === row.mtime;
    if (same) continue;
    const result = await ingestFile(store, row.abs_path, null);
    if (row.missing_at !== null && (result.rule === 'touched' || result.rule === 'updated')) stats.restored++;
    else if (result.rule === 'updated') stats.modified++;
  }
  store.markMissing(gone);
  stats.missing = gone.length;
  return stats;
}

/** 파일시스템 스윕 — 지연 시간을 담당한다. 매번 전체를 돈다. */
export async function sweep(store, reader) {
  const stats = { scanned: 0, inserted: 0, updated: 0, relocated: 0, touched: 0, skipped: 0 };
  const found = [];
  const onDisk = new Set();

  const bundles = [];
  for (const dir of collectibleDirs(reader.sessionsRoot)) {
    const sessionDirName = relative(reader.sessionsRoot, dir).split('/')[0];
    const sessionDir = join(reader.sessionsRoot, sessionDirName);
    // 세션 id 가 없으면 스윕 출처와 보강 출처가 서로 다른 행이 되어 빈 껍데기 출처가 생긴다.
    const sessionRef = splitSessionDirName(sessionDirName)?.sessionId ?? '';
    for (const absPath of listFiles(dir)) {
      found.push({ absPath, sessionDir, sessionRef });
      onDisk.add(nfc(absPath));
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      if (COLLECTIBLE_SUBDIRS.includes(entry.name)) continue;
      const sub = join(dir, entry.name);
      const members = bundleManifest(sub);
      const project = looksLikeProject(sub);
      // 작은 폴더는 한 줄로 접지 않고 파일을 그대로 올린다. 프로젝트 표지가 있으면 개수와
      // 무관하게 접는다 — 파일이 몇 개뿐이어도 스캐폴딩은 산출물이 아니라 한 덩어리다.
      if (!project && members.length < BUNDLE_MIN_FILES) {
        for (const member of members) {
          // 점 파일은 최상위와 같은 이유로 뺀다. 번들 목록에는 남아 있어서 펴면 .DS_Store 가 행이 된다.
          if (member.rel.split('/').some((part) => part.startsWith('.'))) continue;
          const absPath = join(sub, member.rel);
          found.push({ absPath, sessionDir, sessionRef });
          onDisk.add(nfc(absPath));
        }
        continue;
      }
      bundles.push({ dir: sub, sessionDir, sessionRef, project, members });
      onDisk.add(nfc(sub));
    }
  }

  // 삭제 대조를 삽입보다 먼저 한다. 그래야 이름이 바뀐 파일이 inode 로 옛 행을 찾아
  // 태그를 그대로 가져갈 수 있다. 순서가 뒤면 새 행이 생기고 태그가 사라진 행에 갇힌다.
  // 원본이 없어져도 행은 지우지 않는다 — 태그·메모·final 은 재생성할 수 없는 사용자 데이터다.
  const gone = store.db
    .query(`SELECT a.id, a.path_key FROM artifacts a
            WHERE a.missing_at IS NULL
              AND EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = a.id AND o.collector = 'aside')`)
    .all()
    .filter((row) => !onDisk.has(row.path_key))
    .map((row) => row.id);
  store.markMissing(gone);
  stats.missing = gone.length;

  // 세션이 아는 제목·공급자를 파일시스템 수집에도 실어 준다. 보강은 files_changed 를 지나서만
  // 이 값을 얻으므로, 파일은 썼는데 그 기록이 없는 세션은 제목 없이 트리에 남았다.
  const meta = reader.sessionMeta();
  for (const { absPath, sessionDir, sessionRef } of found) {
    stats.scanned++;
    const known = meta.get(sessionRef);
    const result = await ingestFile(store, absPath, {
      collector: 'aside',
      sessionDir,
      sessionRef,
      sessionTitle: known?.title ?? null,
      provider: known?.provider ?? null,
    });
    if (result.rule in stats) stats[result.rule]++;
    else stats.skipped++;
  }

  stats.bundles = 0;
  for (const { dir, sessionDir, sessionRef, project, members } of bundles) {
    const known = meta.get(sessionRef);
    const result = await ingestBundle(store, dir, {
      collector: 'aside',
      sessionDir,
      sessionRef,
      sessionTitle: known?.title ?? null,
      provider: known?.provider ?? null,
    }, { project, members });
    if (result.id) stats.bundles++;
  }

  store.setState('aside.last_sweep_at', nowSeconds());
  return stats;
}

/** state.db 보강 — 권위를 담당한다. 커서는 turn rowid 다. */
export async function enrich(store, reader) {
  if (!reader.available()) return { rows: 0, matched: 0, promoted: 0, widened: 0 };

  const dirMap = reader.sessionDirMap();
  const cursor = Number(store.getState('aside.turn_cursor') ?? 0);
  let rows;
  try {
    rows = reader.changedFiles(cursor);
  } catch (error) {
    store.logIngest({ path: reader.dbPath, level: 'error', code: 'source_db_error', message: String(error.message ?? error) });
    return { rows: 0, matched: 0, promoted: 0, widened: 0, error: String(error.message ?? error) };
  }

  const stats = { rows: rows.length, matched: 0, promoted: 0, widened: 0 };
  let maxTurn = cursor;

  for (const row of rows) {
    maxTurn = Math.max(maxTurn, row.turn_rowid);
    const sessionDirName = dirMap.get(row.session_id);
    if (!sessionDirName || !row.rel_path) continue;
    if (!classifyFilesChangedPath(sessionDirName, row.rel_path).collect) continue;

    const absPath = reader.absPathFor(sessionDirName, row.rel_path);
    const deliverable = row.deliverable_size !== null;
    const origin = {
      collector: 'aside',
      provider: row.provider ?? null,
      sessionRef: row.session_id,
      turnRef: row.turn_ref,
      sessionTitle: row.session_title,
      prompt: row.prompt,
      sessionDir: join(reader.sessionsRoot, sessionDirName),
      createdAt: row.occurred_at,
      isDeliverable: deliverable,
    };

    let artifact = store.byPathKey(absPath);
    if (!artifact) {
      // DB 는 집합을 넓힐 수 있다. 플래그가 붙었는데 스윕이 아직 못 본 경로는 받아들인다.
      // existsSync 는 폴더에도 참이다. 에이전트가 artifacts/ 안에 폴더를 만들고 state.db 가
      // 거기에 산출물 표시를 붙이면 폴더를 해시하려다 EISDIR 로 수집 전체가 죽는다.
      if (!deliverable || !isFileNow(absPath)) continue;
      const result = await ingestFile(store, absPath, origin);
      if (!result.id) continue;
      stats.widened++;
      artifact = store.byPathKey(absPath);
    } else {
      store.recordOrigin(artifact.id, origin);
    }

    stats.matched++;
    if (deliverable) {
      store.applyAutoState(artifact.id, 'final');
      stats.promoted++;
    }
  }

  store.setState('aside.turn_cursor', maxTurn);
  return stats;
}

/**
 * 검색 문서를 만든다. meta 에 세션 제목·공급자·태그·프롬프트를 모아 넣어서
 * "메타데이터 검색"이 별도 질의 경로 없이 같은 MATCH 하나로 처리된다.
 */
export async function reindexArtifact(store, artifactId) {
  const row = store.db.query('SELECT * FROM artifacts WHERE id = ?').get(artifactId);
  if (!row) return null;
  const origins = store.originsOf(artifactId);

  let body = null;
  let title = null;
  let bodyState = BODY_STATE.SKIPPED;
  if (row.bundle_files !== null) {
    // 번들 본문(구성 파일 목록)은 ingestBundle 만 만든다. 디렉터리를 파일처럼 추출하면
    // 태그를 달거나 추출 규칙 버전이 바뀔 때마다 그 목록이 지워진다.
    body = store.db.query('SELECT body FROM search_docs WHERE artifact_id = ?').get(artifactId)?.body ?? null;
    bodyState = body ? BODY_STATE.INDEXED : BODY_STATE.SKIPPED;
  } else if (row.missing_at === null && existsSync(row.abs_path)) {
    const extracted = await extractBody(row.abs_path, row.ext, row.file_name);
    body = extracted.body;
    title = extracted.title ?? null;
    bodyState = extracted.state;
    if (extracted.code && extracted.state === BODY_STATE.FAILED) {
      store.logIngest({ path: row.abs_path, level: 'warn', code: extracted.code, message: extracted.message ?? null });
    }
  }

  // 여러 세션이 건드린 파일은 어느 세션의 기억으로도 찾을 수 있어야 한다. 하나만 색인하면
  // 나머지 세션에서 무엇을 시켰는지로는 영영 도달하지 못한다.
  const meta = [
    ...new Set(origins.flatMap((o) => [o.session_title, o.provider, o.collector, o.prompt])),
    ...store.tagsOf(artifactId),
  ]
    .filter(Boolean)
    .join(' ');

  store.upsertSearchDoc(artifactId, {
    name: row.file_name,
    path: row.abs_path,
    body,
    meta,
    bodyState,
    title,
  });
  return bodyState;
}

/** 아직 색인되지 않았거나 내용이 바뀐 아티팩트만 다시 색인한다. */
export async function indexPending(store, { onProgress } = {}) {
  const rows = store.db
    .query(
      `SELECT a.id FROM artifacts a
       LEFT JOIN search_docs d ON d.artifact_id = a.id
       WHERE d.artifact_id IS NULL OR d.updated_at < a.mtime OR d.body_state = 'pending'`,
    )
    .all();
  const stats = { indexed: 0, skipped: 0, failed: 0 };
  // 본문 추출도 대부분 동기 읽기다. 처음 실행하면 이 단계가 몇 초 걸리므로 여기서도 양보한다.
  const pause = yielder();
  for (const [done, { id }] of rows.entries()) {
    await pause();
    onProgress?.({ step: 'index', done, total: rows.length });
    const state = await reindexArtifact(store, id);
    if (state === BODY_STATE.INDEXED) stats.indexed++;
    else if (state === BODY_STATE.FAILED) stats.failed++;
    else stats.skipped++;
  }
  return stats;
}

/** 스윕 → 보강 → 색인. 워처와 CLI 가 공유하는 한 번의 수집 사이클. */
/**
 * Cursor 는 대화가 고친 파일을 `state.vscdb` 에 남긴다. 그 파일은 이미 저장소 안에 있으므로
 * 옮기지 않고 출처만 붙인다 — Codex · Claude Code 와 같다. 산출물 표시가 없으니 final 로 올리지 않는다.
 *
 * 작업공간은 Cursor 가 알려주지 않는다. 파일이 놓인 곳에서 저장소를 되짚어 채운다(추론이다).
 * 그래야 위치가 실제 경로가 아니라 저장소 이름으로 보이고, worktree 도 본 저장소로 모인다.
 */
export async function sweepCursor(store, reader = new CursorReader(), { onProgress } = {}) {
  const stats = { composers: 0, paths: 0, missing: 0, inserted: 0, updated: 0, touched: 0, relocated: 0, skipped: 0, failed: 0 };
  if (!reader.available()) return stats;

  const since = Number(store.getState('cursor.scanned_until') ?? 0);
  const composers = reader.composers(since);
  stats.composers = composers.length;
  if (composers.length === 0) return stats;

  const pause = yielder();
  const reindexed = new Set();
  const workspaceOf = new Map();
  for (const composer of composers) {
    for (const path of composer.paths) {
      await pause();
      onProgress?.({ step: 'files', source: 'cursor', done: stats.paths, total: composer.paths.length });
      stats.paths++;
      if (!isFileNow(path)) {
        stats.missing++;
        continue;
      }
      const dir = dirname(path);
      if (!workspaceOf.has(dir)) workspaceOf.set(dir, resolveWorkspace(dir).top);
      let result;
      try {
        result = await ingestFile(store, path, {
          collector: 'cursor',
          provider: 'cursor',
          sessionRef: composer.sessionRef,
          sessionTitle: composer.title,
          workspace: workspaceOf.get(dir),
          createdAt: composer.occurredAt,
        });
      } catch (error) {
        store.logIngest({ path, level: 'error', code: 'ingest_failed', message: String(error.message ?? error) });
        stats.failed++;
        continue;
      }
      if (result.rule in stats) stats[result.rule]++;
      else stats.skipped++;
      if (result.id) reindexed.add(result.id);
    }
  }
  for (const id of reindexed) {
    await pause();
    await reindexArtifact(store, id);
  }

  store.setState('cursor.scanned_until', Math.max(since, ...composers.map((c) => c.updatedAtMs)));
  return stats;
}

export async function collectOnce(store, reader, { onProgress } = {}) {
  onProgress?.({ step: 'aside' });
  const swept = await sweep(store, reader);
  const enriched = await enrich(store, reader);
  const indexed = await indexPending(store, { onProgress });
  return { swept, enriched, indexed };
}

/**
 * Codex 와 Claude Code 는 산출물 레코드를 남기지 않는다. 대신 세션 로그가 "어느 경로에
 * 썼는지"를 남기므로, 그 경로를 수확해 아직 존재하는 파일에 출처를 붙인다. 파일을 옮기거나
 * 복사하지 않는다 — 저장소 안에 그대로 두고 어느 작업에서 나왔는지만 기록한다.
 *
 * Aside 가 주지 못하는 workspace 가 여기서는 채워진다.
 */
/** 저장소에서 찾은 문서의 출처. 세션도 공급자도 없다 — 에이전트가 만들었다고 말하지 않는다. */
export function workspaceOrigin(workspace, mtime) {
  return { collector: WORKSPACE_COLLECTOR, sessionRef: '', workspace, provider: null, createdAt: mtime };
}

/**
 * 이미 아는 파일은 건드리지 않는다. 바뀐 내용은 다시 확인이 잡고, 여기서 출처를 더하면 mtime 이
 * 세션 시각보다 늦어 대표 출처가 에이전트에서 '저장소 문서'로 바뀐다.
 */
export async function ingestWorkspaceDoc(store, absPath, workspace) {
  if (store.byPathKey(nfc(absPath))) return { rule: 'known' };
  // fs.watch 는 폴더가 생겨도 알린다. 이름이 문서처럼 생긴 폴더를 그대로 넘기면 EISDIR 로 죽는다.
  const stat = statOrNull(absPath);
  if (!stat?.isFile()) return { rule: 'skipped-not-file' };
  return ingestFile(store, absPath, workspaceOrigin(workspace, Math.floor(stat.mtimeMs / 1000)));
}

/**
 * 작업공간 하나를 훑어 since 이후 바뀐 문서를 넣는다. 처음 한 번만 부른다 — 파일 15만 개를 30초마다
 * 걷지 않고, 그 뒤로는 폴더 감시(fs.watch)가 바뀐 파일만 알려준다.
 */
export async function scanWorkspaceDocs(store, workspace, { since, onProgress } = {}) {
  const stats = { walked: 0, found: 0, ingested: 0 };
  const pause = yielder();
  const walk = async (dir, rel, depth) => {
    if (depth > WORKSPACE_SCAN_MAX_DEPTH || stats.walked >= WORKSPACE_SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      await pause();
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!BUILD_ARTIFACT_DIRS.includes(entry.name)) await walk(join(dir, entry.name), childRel, depth + 1);
        continue;
      }
      stats.walked++;
      if (!entry.isFile() || !isWorkspaceDoc(nfc(childRel))) continue;
      const path = join(dir, entry.name);
      const mtime = Math.floor(statSync(path).mtimeMs / 1000);
      if (mtime < since) continue;
      stats.found++;
      onProgress?.({ step: 'workspaces', done: stats.found, total: stats.found });
      const result = await ingestWorkspaceDoc(store, path, workspace);
      if (result.id) stats.ingested++;
    }
  };
  await walk(workspace, '', 0);
  return stats;
}

/**
 * 로그 파싱은 동기라 이벤트 루프를 붙잡는다. 수집 중 Ctrl-C 가 몇 초씩 안 먹히고, 서버가 뜬 뒤의
 * 주기 수집 동안에는 HTTP 요청이 기다린다. 정해진 시간마다 이벤트 루프를 한 바퀴 돌린다 —
 * 마이크로태스크(await Promise.resolve())는 물론, Bun 의 setImmediate 도 밀린 타이머에 차례를
 * 주지 않았다(테스트로 확인). setTimeout 은 타이머 단계를 거쳐서 준다.
 */
function yielder(everyMs = COLLECT_YIELD_MS) {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < everyMs) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    last = performance.now();
  };
}

/**
 * 지금 그 자리에 보통 파일이 있는가. existsSync 는 폴더에도 참이라, Codex 로그가 저장소 폴더 자체를
 * 쓴 경로로 적은 줄(실측 2건)에서 폴더를 해시하려다 EISDIR 로 죽었다. 패치 본문까지 경로로 잡힌
 * 줄(실측 2건)은 stat 이 ENAMETOOLONG 을 던진다 — 어느 쪽이든 색인할 파일은 없다.
 */
function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isFileNow(path) {
  return statOrNull(path)?.isFile() ?? false;
}

/**
 * tails 는 로그별로 어디까지 읽었는지다. 워처가 프로세스 내내 들고 있어서, 에이전트가 도는 동안
 * 자라는 로그는 새로 붙은 줄만 읽는다. 없으면(1회 sweep) 바뀐 로그를 처음부터 읽는다.
 */
export async function sweepSessionLogs(store, source, { onProgress, tails = new Map() } = {}) {
  const since = Number(store.getState(source.cursorKey) ?? 0);
  const logs = logFilesSince(source.root, source.suffix, since);
  const stats = { logs: logs.length, paths: 0, missing: 0, inserted: 0, updated: 0, touched: 0, relocated: 0, skipped: 0, failed: 0 };
  if (logs.length === 0) return stats;

  // 키에 세션을 포함한다. 경로만으로 키를 잡으면 mtime 순으로 읽는 배치 안에서 같은 파일을
  // 건드린 세션들이 가장 새 것만 남고 조용히 버려진다 — 1:N 스키마로도 되살릴 수 없는 손실이다.
  const discovered = new Map();
  const totalBytes = logs.reduce((sum, log) => sum + log.size, 0);
  const pause = yielder();
  let readBytes = 0;
  for (const [index, log] of logs.entries()) {
    await pause();
    // 파싱은 동기라 이벤트 루프가 멈춘다. 보고를 받은 쪽이 그 자리에서 화면을 갱신해야 한다.
    onProgress?.({ step: 'logs', source: source.collector, done: readBytes, total: totalBytes, files: index, fileTotal: logs.length });
    readBytes += log.size;
    try {
      if (!tails.has(log.path)) tails.set(log.path, newLogTail());
      for (const write of source.parse(log.path, tails.get(log.path))) {
        discovered.set(`${write.sessionRef ?? ''}\u0000${write.path}`, write);
      }
    } catch (error) {
      store.logIngest({ path: log.path, level: 'warn', code: 'session_log_unreadable', message: String(error.message ?? error) });
    }
  }

  // 출처가 늘어 ingestFile 호출이 경로 수보다 많아진다. 본문 추출은 아티팩트당 한 번만.
  const reindexed = new Set();
  for (const write of discovered.values()) {
    await pause();
    onProgress?.({ step: 'files', source: source.collector, done: stats.paths, total: discovered.size });
    stats.paths++;
    // 지워졌거나 옮겨진 파일은 기록하지 않는다. 존재하지 않는 경로를 카탈로그에 넣으면
    // "원본 없음"이 처음부터 붙은 유령 행만 늘어난다.
    if (!isFileNow(write.path)) {
      stats.missing++;
      continue;
    }
    let result;
    try {
      result = await ingestFile(store, write.path, {
        collector: source.collector,
        provider: source.provider,
        sessionRef: write.sessionRef,
        conversationRef: write.conversationRef ?? null,
        workspace: write.workspace,
        prompt: write.prompt,
        sessionTitle: titleFromPrompt(write.prompt, SESSION_TITLE_MAX_CHARS),
        createdAt: write.at,
      });
    } catch (error) {
      // 파일 하나의 실패(읽기 권한, 확인과 해시 사이에 지워짐)가 배치를 죽이면 뒤의 쓰기가 전부 버려진다.
      // 읽은 위치(tails)는 이미 앞으로 갔고 커서도 다음 성공 때 지나가서, 재시작 전에는 다시 읽히지 않는다.
      store.logIngest({ path: write.path, level: 'error', code: 'ingest_failed', message: String(error.message ?? error) });
      stats.failed++;
      continue;
    }
    if (result.rule in stats) stats[result.rule]++;
    else stats.skipped++;
    if (result.id) reindexed.add(result.id);
  }
  for (const [done, id] of [...reindexed].entries()) {
    await pause();
    onProgress?.({ step: 'index', done, total: reindexed.size });
    await reindexArtifact(store, id);
  }

  store.setState(source.cursorKey, Math.max(since, ...logs.map((log) => log.mtimeMs)));
  return stats;
}

export async function collectSessionLogs(store, sources = SESSION_LOG_SOURCES, { onProgress, tails } = {}) {
  // 파서가 바뀌었으면 과거 로그를 다시 읽는다. 출처는 (아티팩트, 수집기, 세션) 키로
  // 멱등하게 쌓이므로 다시 읽어도 행이 겹치지 않는다.
  if (store.getState('session_logs.parser_version') !== String(SESSION_LOG_PARSER_VERSION)) {
    for (const source of sources) store.setState(source.cursorKey, 0);
    store.setState('session_logs.parser_version', SESSION_LOG_PARSER_VERSION);
    // 읽은 위치도 버린다. 남기면 커서만 처음으로 돌고 로그는 끝부분만 읽혀 재파싱이 헛돈다.
    tails?.clear();
  }
  const out = {};
  for (const source of sources) out[source.collector] = await sweepSessionLogs(store, source, { onProgress, tails });
  return out;
}

/** 번들의 정체성은 내용물 목록이다. 파일을 읽지 않고 stat 만으로 만든다. */
function bundleManifest(dir) {
  const entries = [];
  const walk = (current, prefix) => {
    if (entries.length >= MAX_BUNDLE_MEMBERS) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (BUILD_ARTIFACT_DIRS.includes(entry.name)) continue;
      const path = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) {
        const stat = statSync(path);
        entries.push({ rel, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) });
      }
    }
  };
  walk(dir, '');
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

export function looksLikeProject(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/** 프로젝트 디렉터리 하나를 아티팩트 한 줄로 만든다. 내용물은 검색 본문으로 남는다. */
export async function ingestBundle(store, dir, origin, { project = false, members = null } = {}) {
  // 스윕은 접을지 정하려고 이미 목록을 걸었다. 다시 걸면 큰 폴더를 두 번 훑는다.
  const entries = members ?? bundleManifest(dir);
  if (entries.length === 0) return { rule: 'skipped-empty' };

  const pathKey = nfc(dir);
  const manifest = entries.map((e) => `${e.rel}:${e.size}:${e.mtime}`).join('\n');
  const hash = createHash('sha256').update(manifest).digest('hex');
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  const newest = Math.max(...entries.map((e) => e.mtime));
  const name = nfc(dir.split('/').pop());

  const existing = store.byPathKey(pathKey);
  let id;
  let rule;
  if (existing) {
    id = existing.id;
    rule = existing.content_hash === hash ? 'touched' : 'updated';
    store.updateContent(id, { contentHash: hash, sizeBytes: totalBytes, mtime: newest, fileId: existing.file_id });
  } else {
    id = store.insertArtifact({
      pathKey,
      absPath: dir,
      fileName: name,
      ext: '',
      sizeBytes: totalBytes,
      contentHash: hash,
      fileId: null,
      mtime: newest,
      discoveredAt: nowSeconds(),
    });
    rule = 'inserted';
  }

  store.setBundleFiles(id, entries.length);
  if (origin) store.recordOrigin(id, origin);
  store.upsertSearchDoc(id, {
    name,
    path: dir,
    body: entries.map((e) => e.rel).join('\n'),
    meta: [origin?.sessionTitle, origin?.provider, project ? '프로젝트' : '폴더', ...store.tagsOf(id)].filter(Boolean).join(' '),
    bodyState: BODY_STATE.INDEXED,
  });
  return { id, rule, files: entries.length };
}
