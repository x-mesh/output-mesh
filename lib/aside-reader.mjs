import { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asideSessionsRoot, asideStateDb, nfc } from './paths.mjs';
import { splitSessionDirName } from './scanner.mjs';

/**
 * json_valid 가드가 없으면 files_changed 에 깨진 JSON 행이 하나만 있어도 json_each 가
 * 중간에 abort 하고, 이미 반환된 행들이 성공한 부분 결과처럼 보인다.
 */
const TURNS_QUERY = `
SELECT s.id                                        AS session_id,
       s.title                                     AS session_title,
       json_extract(s.model, '$.provider')         AS provider,
       t.id                                        AS turn_rowid,
       t.turn_id                                   AS turn_ref,
       t.user_message                              AS prompt,
       COALESCE(t.finished_at, t.started_at)       AS occurred_at,
       json_extract(e.value, '$.path')             AS rel_path,
       json_extract(e.value, '$.type')             AS change_type,
       json_extract(e.value, '$.artifact.sizeBytes') AS deliverable_size
FROM   session_turns t
JOIN   sessions s ON s.id = t.session_id
JOIN   json_each(t.files_changed) AS e
WHERE  json_valid(t.files_changed)
  AND  t.id > ?
ORDER BY t.id ASC`;

/**
 * session_turns.user_message 는 `[{role, content, timestamp}]` JSON 이다. 원문 그대로
 * 색인하면 role 이나 timestamp 같은 구조 문자열이 trigram 인덱스를 오염시킨다.
 * 사용자가 실제로 친 말(role === 'user')만 뽑는다.
 */
export function extractPromptText(userMessage) {
  if (!userMessage) return null;
  let parsed;
  try {
    parsed = JSON.parse(userMessage);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const text = parsed
    .filter((entry) => entry?.role === 'user' && typeof entry.content === 'string')
    .map((entry) => entry.content)
    .join('\n')
    .trim();
  return text === '' ? null : text;
}

export class AsideReader {
  constructor(accountDir) {
    this.accountDir = accountDir;
    this.sessionsRoot = asideSessionsRoot(accountDir);
    this.dbPath = asideStateDb(accountDir);
  }

  available() {
    return existsSync(this.dbPath);
  }

  /** 세션 디렉터리명에 날짜 접두사가 붙어 있는데 DB에는 없어서, 조인하려면 이 맵이 필요하다. */
  sessionDirMap() {
    if (!existsSync(this.sessionsRoot)) return new Map();
    const map = new Map();
    for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const parsed = splitSessionDirName(entry.name);
      if (parsed) map.set(parsed.sessionId, entry.name);
    }
    return map;
  }

  /**
   * 읽기 전용으로 직접 연다. `.db`만 복사하면 WAL 을 잃고, readonly 는 드라이버가 쓰기를
   * 거부하므로 PRD 의 "원본 데이터에 쓰지 않는다"가 연결 설정으로 보장된다.
   */
  open() {
    return new Database(this.dbPath, { readonly: true });
  }

  changedFiles(sinceTurnRowid = 0) {
    const db = this.open();
    try {
      return db
        .query(TURNS_QUERY)
        .all(sinceTurnRowid)
        .map((row) => ({ ...row, prompt: extractPromptText(row.prompt) }));
    } finally {
      db.close();
    }
  }

  maxTurnRowid() {
    const db = this.open();
    try {
      return db.query('SELECT COALESCE(MAX(id), 0) AS m FROM session_turns').get().m;
    } finally {
      db.close();
    }
  }

  absPathFor(sessionDirName, relPathInSession) {
    return nfc(join(this.sessionsRoot, sessionDirName, relPathInSession));
  }
}
