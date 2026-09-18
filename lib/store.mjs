import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_DB, SQLITE_BUSY_TIMEOUT_MS, nfc } from './paths.mjs';
import { EXTRACT_RULES_VERSION, KIND_RULES_VERSION, kindOf } from './extract.mjs';
import { extOf, splitSessionDirName } from './scanner.mjs';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export class CatalogStore {
  constructor(path = CATALOG_DB) {
    // 첫 수집처럼 한꺼번에 수천 개를 처음 보는 동안에는 변경 기록을 남기지 않는다. 호출하는 쪽이 켠다.
    this.quietEvents = false;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // SQLite는 연결별로 foreign_keys가 기본 OFF다. 켜지 않으면 ON DELETE CASCADE가 죽은 코드가 된다.
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    this.#ensureKind();
    this.#ensureDocTitle();
    // 컬럼을 먼저 붙인다. 출처 마이그레이션이 recordOrigin 으로 이 컬럼에 쓴다.
    this.#ensureConversationRef();
    this.#ensureOrigins();
  }

  /**
   * 대화 단위로 묶기 위한 컬럼. 채우는 건 세션 로그 파서 버전이 바뀌어 로그를 다시 읽을
   * 때다 — NULL 은 "session_ref 가 곧 대화"로 읽히므로 채워지기 전에도 틀리지 않는다.
   * 인덱스를 schema.sql 에 두지 않는다: 기존 카탈로그에서는 스키마 배치가 이 ALTER 보다
   * 먼저 돌아 없는 컬럼을 가리키게 된다.
   */
  #ensureConversationRef() {
    const columns = this.db.query('PRAGMA table_info(artifact_origins)').all().map((column) => column.name);
    if (!columns.includes('conversation_ref')) {
      this.db.exec('ALTER TABLE artifact_origins ADD COLUMN conversation_ref TEXT');
    }
  }

  /**
   * 1:1 provenance 를 1:N artifact_origins 로 옮긴다. 게이트는 "방금 만들었는가"가 아니라
   * "아직 출처로 옮겨지지 않은 provenance 행이 있는가"다 — 예전 빌드가 넣은 행도 다음
   * 실행이 스스로 고친다. artifacts·tags·artifact_tags 는 읽지도 쓰지도 않는다.
   */
  #ensureOrigins() {
    const pending = this.db
      .query(`SELECT p.* FROM provenance p
              WHERE NOT EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = p.artifact_id)`)
      .all();
    if (pending.length === 0) return;

    const now = nowSeconds();
    this.db.transaction(() => {
      for (const row of pending) {
        this.recordOrigin(row.artifact_id, {
          collector: repairCollector(row.collector, row.provider),
          provider: row.provider,
          sessionRef: row.session_ref ?? sessionFromDir(row.session_dir),
          turnRef: row.turn_ref,
          sessionTitle: row.session_title,
          prompt: row.prompt,
          sessionDir: row.session_dir,
          workspace: row.workspace,
          createdAt: row.created_at,
          isDeliverable: row.is_deliverable === 1,
        }, row.created_at ?? now);
      }
    })();

    // 1:1 은 한 세션만 남기고 나머지를 버렸다. 버려진 출처는 로그를 다시 읽어야만 돌아온다.
    this.setState('codex.scanned_until', 0);
    this.setState('claude.scanned_until', 0);
  }

  /**
   * search_docs 는 파일에서 다시 뽑을 수 있는 캐시라 제목도 여기 둔다. 추출 규칙이 바뀌면
   * 행을 지우지 않고 pending 으로 돌린다 — indexPending 이 다음 수집에서 다시 뽑는다.
   */
  #ensureDocTitle() {
    const columns = this.db.query('PRAGMA table_info(search_docs)').all().map((column) => column.name);
    if (!columns.includes('title')) this.db.exec('ALTER TABLE search_docs ADD COLUMN title TEXT');

    if (this.getState('extract.rules_version') !== String(EXTRACT_RULES_VERSION)) {
      this.db.exec("UPDATE search_docs SET body_state = 'pending'");
      this.setState('extract.rules_version', EXTRACT_RULES_VERSION);
    }
  }

  /**
   * CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을 덧붙이지 못한다. 카탈로그에는 태그·메모·
   * final 표시처럼 디스크에서 재생성할 수 없는 사용자 데이터가 있으므로, 다시 만들지 않고
   * 자리에서 붙이고 채운다.
   */
  #ensureKind() {
    const columns = this.db.query('PRAGMA table_info(artifacts)').all().map((column) => column.name);
    if (!columns.includes('kind')) this.db.exec('ALTER TABLE artifacts ADD COLUMN kind TEXT');

    if (this.getState('kind.rules_version') !== String(KIND_RULES_VERSION)) {
      this.db.exec('UPDATE artifacts SET kind = NULL');
      this.setState('kind.rules_version', KIND_RULES_VERSION);
    }

    // NULL 을 기준으로 채운다. 컬럼을 모르는 예전 빌드가 행을 넣어도 다음 실행이 스스로 고친다.
    const stale = this.db.query('SELECT id, ext, file_name, bundle_files FROM artifacts WHERE kind IS NULL').all();
    if (stale.length === 0) return;
    const set = this.db.query('UPDATE artifacts SET kind = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const row of stale) set.run(classify(row.ext, row.file_name, row.bundle_files), row.id);
    })();
  }

  close() {
    this.db.close();
  }

  journalMode() {
    return this.db.query('PRAGMA journal_mode').get().journal_mode;
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  getState(key) {
    return this.db.query('SELECT value FROM collector_state WHERE key = ?').get(key)?.value ?? null;
  }

  setState(key, value) {
    this.db
      .query('INSERT INTO collector_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  logIngest({ path = null, level = 'error', code, message = null, at = nowSeconds() }) {
    this.db
      .query('INSERT INTO ingest_events(path, level, code, message, at) VALUES(?, ?, ?, ?, ?)')
      .run(path, level, code, message, at);
  }

  recentIngestEvents(limit = 50) {
    return this.db.query('SELECT * FROM ingest_events ORDER BY at DESC, id DESC LIMIT ?').all(limit);
  }

  byPathKey(pathKey) {
    return this.db.query('SELECT * FROM artifacts WHERE path_key = ?').get(pathKey) ?? null;
  }

  /** 경로가 사라진 행 중 같은 inode를 가진 것 — 이름 변경을 새 아티팩트로 오인하지 않기 위한 조회. */
  missingByFileId(fileId) {
    if (!fileId) return null;
    return this.db
      .query('SELECT * FROM artifacts WHERE file_id = ? AND missing_at IS NOT NULL ORDER BY missing_at DESC LIMIT 1')
      .get(fileId) ?? null;
  }

  insertArtifact(row) {
    const info = this.db
      .query(
        `INSERT INTO artifacts
           (path_key, abs_path, file_name, ext, kind, size_bytes, content_hash, file_id, mtime, discovered_at)
         VALUES ($path_key, $abs_path, $file_name, $ext, $kind, $size_bytes, $content_hash, $file_id, $mtime, $discovered_at)`,
      )
      .run({
        $path_key: row.pathKey,
        $abs_path: row.absPath,
        $file_name: row.fileName,
        $ext: row.ext,
        // 호출부가 아니라 여기서 파생한다. 쓰기 경로가 늘어도 빠뜨릴 수 없다.
        $kind: classify(row.ext, row.fileName, null),
        $size_bytes: row.sizeBytes,
        $content_hash: row.contentHash ?? null,
        $file_id: row.fileId ?? null,
        $mtime: row.mtime,
        $discovered_at: row.discoveredAt ?? nowSeconds(),
      });
    return Number(info.lastInsertRowid);
  }

  /** 번들 여부와 분류를 한 문장에서 쓴다. 둘이 어긋날 수 있는 틈을 만들지 않는다. */
  setBundleFiles(id, files) {
    this.db.query("UPDATE artifacts SET bundle_files = ?, kind = 'bundle' WHERE id = ?").run(files, id);
  }

  touchArtifact(id, { mtime, sizeBytes }) {
    this.db
      .query('UPDATE artifacts SET mtime = ?, size_bytes = ?, missing_at = NULL WHERE id = ?')
      .run(mtime, sizeBytes, id);
  }

  updateContent(id, { contentHash, sizeBytes, mtime, fileId }) {
    this.db
      .query(
        'UPDATE artifacts SET content_hash = ?, size_bytes = ?, mtime = ?, file_id = ?, missing_at = NULL WHERE id = ?',
      )
      .run(contentHash ?? null, sizeBytes, mtime, fileId ?? null, id);
  }

  /** 이름이 바뀌면 확장자와 분류도 따라간다. 파일명이 분류에 참여하므로 같이 갱신해야 한다. */
  relocate(id, { pathKey, absPath, fileName, mtime, sizeBytes }) {
    const ext = extOf(fileName);
    this.db
      .query(
        `UPDATE artifacts SET path_key = ?, abs_path = ?, file_name = ?, ext = ?, kind = ?,
                              mtime = ?, size_bytes = ?, missing_at = NULL WHERE id = ?`,
      )
      .run(pathKey, absPath, fileName, ext, classify(ext, fileName, null), mtime, sizeBytes, id);
  }

  markMissing(ids, at = nowSeconds()) {
    if (ids.length === 0) return;
    const stmt = this.db.query('UPDATE artifacts SET missing_at = ? WHERE id = ? AND missing_at IS NULL');
    // 이미 없던 것은 다시 적지 않는다. 사라진 순간 한 번만 기록된다.
    for (const id of ids) if (stmt.run(at, id).changes > 0) this.recordEvent(id, 'missing', { at });
  }

  isEmpty() {
    return this.db.query('SELECT 1 FROM artifacts LIMIT 1').get() === null;
  }

  /** origin 이 있으면 수집기가 본 변화(agent), 없으면 다시 확인이 디스크에서 본 변화(disk)다. */
  recordEvent(artifactId, kind, { origin = null, at = nowSeconds() } = {}) {
    if (this.quietEvents) return;
    this.db
      .query(`INSERT INTO artifact_events (artifact_id, kind, source, collector, provider, session_ref, at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(artifactId, kind, origin ? 'agent' : 'disk', origin?.collector ?? null, origin?.provider ?? null, origin?.sessionRef || null, at);
  }

  lastEventId() {
    return this.db.query('SELECT COALESCE(MAX(id), 0) AS n FROM artifact_events').get().n;
  }

  /** 번호 차이로 세지 않는다. 오래된 줄을 지우면 번호가 비어 차이가 개수보다 커진다. */
  countEventsAfter(id) {
    return this.db.query('SELECT COUNT(*) AS n FROM artifact_events WHERE id > ?').get(id).n;
  }

  pruneEvents(before) {
    this.db.query('DELETE FROM artifact_events WHERE at < ?').run(before);
  }

  /**
   * 출처 한 줄을 기록한다. 같은 (아티팩트, 수집기, 세션) 을 다시 보면 새 행 없이 갱신만 한다.
   * 한 키 안의 기록자는 항상 같은 소스라 컬럼별 COALESCE 가 출처를 섞을 수 없다 —
   * 섞임(chimera)은 키가 틀렸을 때만 생긴다.
   */
  recordOrigin(artifactId, origin, seenAt = nowSeconds()) {
    this.db
      .query(
        `INSERT INTO artifact_origins
           (artifact_id, collector, session_ref, conversation_ref, turn_ref, provider, session_title, prompt,
            session_dir, workspace, is_deliverable, occurred_at, first_seen_at, last_seen_at)
         VALUES ($id, $collector, $session_ref, $conversation_ref, $turn_ref, $provider, $session_title, $prompt,
                 $session_dir, $workspace, $is_deliverable, $occurred_at, $seen, $seen)
         ON CONFLICT(artifact_id, collector, session_ref) DO UPDATE SET
           conversation_ref = COALESCE(excluded.conversation_ref, artifact_origins.conversation_ref),
           turn_ref       = COALESCE(excluded.turn_ref, artifact_origins.turn_ref),
           provider       = COALESCE(excluded.provider, artifact_origins.provider),
           session_title  = COALESCE(excluded.session_title, artifact_origins.session_title),
           prompt         = COALESCE(excluded.prompt, artifact_origins.prompt),
           session_dir    = COALESCE(excluded.session_dir, artifact_origins.session_dir),
           workspace      = COALESCE(excluded.workspace, artifact_origins.workspace),
           -- Aside 의 산출물 표시는 긍정 주장이고 다른 출처는 정보가 없을 뿐이다. 취소하지 않는다.
           is_deliverable = MAX(excluded.is_deliverable, artifact_origins.is_deliverable),
           occurred_at    = COALESCE(MAX(excluded.occurred_at, artifact_origins.occurred_at),
                                     excluded.occurred_at, artifact_origins.occurred_at),
           -- first_seen_at 은 건드리지 않는다. 재관측은 last_seen_at 만 민다.
           last_seen_at   = excluded.last_seen_at`,
      )
      .run({
        $id: artifactId,
        $collector: origin.collector,
        $session_ref: origin.sessionRef ?? '',
        $conversation_ref: origin.conversationRef ?? null,
        $turn_ref: origin.turnRef ?? null,
        $provider: origin.provider ?? null,
        $session_title: origin.sessionTitle ?? null,
        $prompt: origin.prompt ?? null,
        $session_dir: origin.sessionDir ?? null,
        $workspace: origin.workspace ?? null,
        $is_deliverable: origin.isDeliverable ? 1 : 0,
        $occurred_at: origin.createdAt ?? null,
        $seen: seenAt,
      });
  }

  /** 대표 출처가 맨 앞에 오는 순서. rowid 를 쓰지 않는다 — VACUUM 이 재번호해 대표가 바뀐다. */
  originsOf(artifactId) {
    return this.db
      .query(
        `SELECT * FROM artifact_origins WHERE artifact_id = ?
         ORDER BY is_deliverable DESC, occurred_at DESC, collector, session_ref`,
      )
      .all(artifactId);
  }

  /** 자동 스윕은 사용자가 직접 정한 상태를 덮어쓰지 않는다. */
  applyAutoState(artifactId, state) {
    this.db
      .query('UPDATE artifacts SET state = ? WHERE id = ? AND state_locked = 0')
      .run(state, artifactId);
  }

  setUserState(artifactId, state) {
    const hash = this.db.query('SELECT content_hash FROM artifacts WHERE id = ?').get(artifactId)?.content_hash ?? null;
    this.db
      .query('UPDATE artifacts SET state = ?, state_locked = 1, final_hash = ? WHERE id = ?')
      .run(state, state === 'final' ? hash : null, artifactId);
  }

  setFavorite(artifactId, on) {
    this.db.query('UPDATE artifacts SET favorite = ? WHERE id = ?').run(on ? 1 : 0, artifactId);
  }

  setNote(artifactId, note) {
    this.db.query('UPDATE artifacts SET note = ? WHERE id = ?').run(note ?? null, artifactId);
  }

  setAllowScripts(artifactId, on) {
    this.db.query('UPDATE artifacts SET allow_scripts = ? WHERE id = ?').run(on ? 1 : 0, artifactId);
  }

  addTag(artifactId, name) {
    const nameKey = nfc(name).toLowerCase();
    this.db.query('INSERT INTO tags(name, name_key) VALUES(?, ?) ON CONFLICT(name_key) DO NOTHING').run(nfc(name), nameKey);
    const tagId = this.db.query('SELECT id FROM tags WHERE name_key = ?').get(nameKey).id;
    this.db
      .query('INSERT INTO artifact_tags(artifact_id, tag_id) VALUES(?, ?) ON CONFLICT DO NOTHING')
      .run(artifactId, tagId);
    return tagId;
  }

  removeTag(artifactId, name) {
    const nameKey = nfc(name).toLowerCase();
    this.db
      .query('DELETE FROM artifact_tags WHERE artifact_id = ? AND tag_id = (SELECT id FROM tags WHERE name_key = ?)')
      .run(artifactId, nameKey);
  }

  tagsOf(artifactId) {
    return this.db
      .query('SELECT t.name FROM tags t JOIN artifact_tags at ON at.tag_id = t.id WHERE at.artifact_id = ? ORDER BY t.name')
      .all(artifactId)
      .map((r) => r.name);
  }

  upsertSearchDoc(artifactId, { name, path, body, meta, bodyState, title }) {
    this.db
      .query(
        `INSERT INTO search_docs(artifact_id, name, path, body, meta, body_state, updated_at, title)
         VALUES ($id, $name, $path, $body, $meta, $body_state, $updated_at, $title)
         ON CONFLICT(artifact_id) DO UPDATE SET
           name = excluded.name, path = excluded.path, body = excluded.body,
           meta = excluded.meta, body_state = excluded.body_state, updated_at = excluded.updated_at,
           title = excluded.title`,
      )
      .run({
        $id: artifactId,
        $name: nfc(name),
        $path: nfc(path),
        $body: body ?? null,
        $meta: meta ?? null,
        $body_state: bodyState ?? 'pending',
        $updated_at: nowSeconds(),
        $title: title ?? null,
      });
  }

  duplicateGroups() {
    return this.db.query('SELECT * FROM duplicate_groups ORDER BY n DESC').all();
  }

  ftsIntegrityOk() {
    try {
      this.db.exec("INSERT INTO artifact_fts(artifact_fts) VALUES('integrity-check')");
      return true;
    } catch {
      return false;
    }
  }

  rebuildFts() {
    this.db.exec("INSERT INTO artifact_fts(artifact_fts) VALUES('rebuild')");
  }

  counts() {
    const one = (sql) => this.db.query(sql).get().n;
    return {
      artifacts: one('SELECT COUNT(*) n FROM artifacts'),
      missing: one('SELECT COUNT(*) n FROM artifacts WHERE missing_at IS NOT NULL'),
      final: one("SELECT COUNT(*) n FROM artifacts WHERE state = 'final'"),
      enriched: one("SELECT COUNT(DISTINCT artifact_id) n FROM artifact_origins WHERE session_ref <> ''"),
      deliverable: one('SELECT COUNT(DISTINCT artifact_id) n FROM artifact_origins WHERE is_deliverable = 1'),
      indexed: one("SELECT COUNT(*) n FROM search_docs WHERE body_state = 'indexed'"),
      // 분류가 빈 행은 라이브러리에서 조용히 사라질 수 있는 최악의 상태다. 보이게 둔다.
      kindNull: one('SELECT COUNT(*) n FROM artifacts WHERE kind IS NULL'),
      origins: one('SELECT COUNT(*) n FROM artifact_origins'),
      // 마이그레이션 정합성. 출처가 없는 아티팩트는 칩도 활동 보기도 없이 조용히 사라진다.
      artifactsWithoutOrigin: one(`SELECT COUNT(*) n FROM artifacts a
        WHERE NOT EXISTS (SELECT 1 FROM artifact_origins o WHERE o.artifact_id = a.id)`),
      originsOrphan: one(`SELECT COUNT(*) n FROM artifact_origins o
        WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.id = o.artifact_id)`),
      // 전수 재파싱 뒤에도 0 이면 세션 로그 배치가 다른 세션을 뭉개고 있다는 뜻이다.
      multiOrigin: one(`SELECT COUNT(*) n FROM (SELECT artifact_id FROM artifact_origins
        GROUP BY artifact_id HAVING COUNT(*) > 1)`),
      multiProvider: one(`SELECT COUNT(*) n FROM (SELECT artifact_id FROM artifact_origins
        WHERE provider IS NOT NULL GROUP BY artifact_id HAVING COUNT(DISTINCT provider) > 1)`),
      // 한 줄 안에서 수집기와 공급자가 서로 다른 세션을 가리키는 행. 원래 버그의 흔적이다.
      chimeraOrigins: one(`SELECT COUNT(*) n FROM artifact_origins
        WHERE (collector = 'codex' AND provider IS NOT 'openai-codex')
           OR (collector = 'claude-code' AND provider IS NOT 'claude-code')`),
    };
  }
}

/**
 * 1:1 시절에는 collector 만 첫 기록자로 남고 나머지는 마지막 기록자로 덮였다. 세션 로그
 * 수집기는 collector 마다 공급자가 고정이라, 공급자에서 collector 를 되짚을 수 있다.
 */
const COLLECTOR_OF_PROVIDER = { 'openai-codex': 'codex', 'claude-code': 'claude-code' };

export function repairCollector(collector, provider) {
  if (collector !== 'codex' && collector !== 'claude-code') return collector;
  return COLLECTOR_OF_PROVIDER[provider] ?? collector;
}

/** Aside 세션 디렉터리명(`<날짜>_<세션id>`)에서 세션 id 를 꺼낸다. */
export function sessionFromDir(sessionDir) {
  if (!sessionDir) return '';
  return splitSessionDirName(sessionDir.split('/').pop())?.sessionId ?? '';
}

/** 번들이면 bundle, 아니면 확장자와 파일명에서 분류한다. */
export function classify(ext, fileName, bundleFiles) {
  return bundleFiles ? 'bundle' : kindOf(ext ?? '', fileName ?? '');
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
