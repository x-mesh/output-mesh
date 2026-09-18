CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY,
  path_key      TEXT    NOT NULL UNIQUE,
  abs_path      TEXT    NOT NULL,
  file_name     TEXT    NOT NULL,
  ext           TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  content_hash  TEXT,
  file_id       TEXT,
  mtime         INTEGER NOT NULL,
  discovered_at INTEGER NOT NULL,
  missing_at    INTEGER,
  state         TEXT    NOT NULL DEFAULT 'discovered',
  state_locked  INTEGER NOT NULL DEFAULT 0,
  final_hash    TEXT,
  favorite      INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  allow_scripts INTEGER NOT NULL DEFAULT 0,
  bundle_files  INTEGER,
  kind          TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash  ON artifacts(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_mtime ON artifacts(mtime DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_state ON artifacts(state, mtime DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_fileid ON artifacts(file_id) WHERE file_id IS NOT NULL;

-- 읽기 전용 잔재. artifact_origins 로 옮기기 위한 백필 입력이자 유일한 롤백 경로다.
-- 새 카탈로그에서는 항상 비어 있다. 아무도 여기에 쓰지 않는다.
CREATE TABLE IF NOT EXISTS provenance (
  artifact_id    INTEGER PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  collector      TEXT NOT NULL,
  provider       TEXT,
  session_ref    TEXT,
  turn_ref       TEXT,
  session_title  TEXT,
  prompt         TEXT,
  session_dir    TEXT,
  workspace      TEXT,
  created_at     INTEGER,
  is_deliverable INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prov_session  ON provenance(session_ref);
CREATE INDEX IF NOT EXISTS idx_prov_provider ON provenance(provider);

-- 한 아티팩트의 출처는 여럿이다. 경로 700개 중 148개(21%)를 세션 2개 이상이, 37개를
-- 공급자 2곳이 건드렸다. 1:1 로 두면 덮어쓸 수밖에 없어 출처가 사라지고 섞였다.
-- 키에 turn 을 넣지 않는다: 한 세션이 같은 파일을 여러 턴에 걸쳐 고쳐도 출처는 하나다.
-- session_ref 는 NULL 이 아니라 '' 다 — SQLite 는 PK 의 NULL 을 서로 다른 값으로 보아
-- 세션 개념이 없는 가져오기 출처가 스윕마다 새 행으로 쌓인다.
CREATE TABLE IF NOT EXISTS artifact_origins (
  artifact_id    INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  collector      TEXT    NOT NULL,
  session_ref    TEXT    NOT NULL DEFAULT '',
  -- 스레드가 속한 대화. Codex 는 대화 하나가 서브에이전트 스레드를 수십 개 띄우고
  -- 스레드마다 로그가 따로 남는다. NULL 이면 session_ref 자체가 대화다.
  -- 기존 카탈로그에는 store 가 ALTER 로 붙인다.
  conversation_ref TEXT,
  turn_ref       TEXT,
  provider       TEXT,
  session_title  TEXT,
  prompt         TEXT,
  session_dir    TEXT,
  workspace      TEXT,
  is_deliverable INTEGER NOT NULL DEFAULT 0,
  occurred_at    INTEGER,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, collector, session_ref)
);
-- 같은 배치에서 통째로 생기는 새 테이블이라 인덱스도 여기 둔다. 기존 테이블에 ALTER 로
-- 붙인 컬럼의 인덱스는 여기 두면 안 된다(스키마 배치가 ALTER 보다 먼저 돈다).
CREATE INDEX IF NOT EXISTS idx_origins_provider  ON artifact_origins(provider, artifact_id);
CREATE INDEX IF NOT EXISTS idx_origins_workspace ON artifact_origins(workspace, artifact_id);
CREATE INDEX IF NOT EXISTS idx_origins_session   ON artifact_origins(collector, session_ref);

CREATE TABLE IF NOT EXISTS tags (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS artifact_tags (
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, tag_id)
);

CREATE TABLE IF NOT EXISTS ingest_events (
  id      INTEGER PRIMARY KEY,
  path    TEXT,
  level   TEXT NOT NULL,
  code    TEXT NOT NULL,
  message TEXT,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_at ON ingest_events(at DESC);

CREATE TABLE IF NOT EXISTS collector_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS search_docs (
  artifact_id INTEGER PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT,
  meta TEXT,
  body_state TEXT NOT NULL DEFAULT 'pending',
  updated_at INTEGER NOT NULL,
  title TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  name, path, body, meta,
  content = 'search_docs', content_rowid = 'artifact_id',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO artifact_fts(rowid, name, path, body, meta)
  VALUES (new.artifact_id, new.name, new.path, new.body, new.meta);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, name, path, body, meta)
  VALUES ('delete', old.artifact_id, old.name, old.path, old.body, old.meta);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, name, path, body, meta)
  VALUES ('delete', old.artifact_id, old.name, old.path, old.body, old.meta);
  INSERT INTO artifact_fts(rowid, name, path, body, meta)
  VALUES (new.artifact_id, new.name, new.path, new.body, new.meta);
END;

CREATE VIEW IF NOT EXISTS duplicate_groups AS
  SELECT content_hash, COUNT(*) AS n
  FROM artifacts
  WHERE content_hash IS NOT NULL AND missing_at IS NULL
  GROUP BY content_hash HAVING COUNT(*) > 1;
