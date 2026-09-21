import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nfc } from './paths.mjs';

export const CURSOR_STATE_DB = join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');

/**
 * Cursor 는 로그 파일을 남기지 않는다. 고친 파일은 `state.vscdb` 의 키-값 저장소에 있고,
 * 쓸 수 있는 자리는 `composerData:<uuid>` 하나뿐이다(실측 48행 중 파일 기록 10건).
 *
 * 다른 두 후보는 버렸다. 세션별 `~/.cursor/chats/<작업공간>/<세션>/store.db` 는 558개를 다 열어 봐도 도구가
 * 전부 읽기였고(Read 1150 · Grep 676 · Shell 290), 전역 `agentKv:blob:<sha256>` 에는 쓰기가
 * 있지만 키가 내용 해시라 어느 세션의 언제인지를 붙일 수 없다.
 */
const COMPOSERS_QUERY = `
SELECT key, value
FROM   cursorDiskKV
WHERE  key LIKE 'composerData:%'`;

const FILE_URI = 'file://';

/** `originalFileStates` 는 고친 파일, `newlyCreatedFiles` 는 새로 만든 파일이다. 둘 다 file:// URI 를 담는다. */
function pathsFrom(composer) {
  const out = new Set();
  const take = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      for (const key of ['fsPath', 'path', 'uri', 'relativeWorkspacePath']) {
        const found = value[key];
        if (typeof found === 'string') return found;
        if (found && typeof found === 'object' && typeof found.fsPath === 'string') return found.fsPath;
      }
    }
    return null;
  };
  for (const field of ['newlyCreatedFiles', 'originalFileStates']) {
    const collection = composer?.[field];
    const values = Array.isArray(collection) ? collection : collection && typeof collection === 'object' ? Object.entries(collection).flat() : [];
    for (const value of values) {
      const raw = take(value);
      if (typeof raw !== 'string') continue;
      // URI 는 퍼센트 인코딩될 수 있다. 디코딩이 실패하면 원문이 경로가 아니라는 뜻이라 버린다.
      let path = raw.startsWith(FILE_URI) ? raw.slice(FILE_URI.length) : raw;
      if (!path.startsWith('/')) continue;
      try {
        path = decodeURIComponent(path);
      } catch {
        continue;
      }
      out.add(nfc(path));
    }
  }
  return [...out];
}

/** 제목은 사람이 붙인 이름이 먼저고, 없으면 첫 발화다. 둘 다 없으면 화면이 "제목 없는 작업"을 쓴다. */
function titleOf(composer) {
  for (const field of ['name', 'text']) {
    const value = composer?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  return null;
}

const MS = 1000;

export class CursorReader {
  constructor(dbPath = CURSOR_STATE_DB) {
    this.dbPath = dbPath;
  }

  available() {
    return existsSync(this.dbPath);
  }

  /**
   * 읽기 전용으로 직접 연다. Aside 와 같은 이유다 — 복사하면 WAL 을 잃고, readonly 는 드라이버가
   * 쓰기를 거부하므로 "원본 데이터에 쓰지 않는다"가 연결 설정으로 보장된다.
   */
  open() {
    return new Database(this.dbPath, { readonly: true });
  }

  /**
   * 파일을 건드린 대화만 돌려준다. `since` 는 밀리초라 마지막으로 읽은 `lastUpdatedAt` 을 그대로 쓴다.
   * 커서를 초 단위로 줄이면 같은 밀리초의 대화가 가려진다.
   */
  composers(sinceMs = 0) {
    if (!this.available()) return [];
    const db = this.open();
    try {
      const out = [];
      for (const row of db.query(COMPOSERS_QUERY).all()) {
        let composer;
        try {
          composer = JSON.parse(row.value);
        } catch {
          continue;
        }
        const updatedAt = Number(composer?.lastUpdatedAt ?? composer?.createdAt ?? 0);
        if (!Number.isFinite(updatedAt) || updatedAt <= sinceMs) continue;
        const paths = pathsFrom(composer);
        if (paths.length === 0) continue;
        out.push({
          sessionRef: String(composer.composerId ?? row.key.slice('composerData:'.length)),
          title: titleOf(composer),
          // 화면과 피드는 초를 쓴다. 대화가 살아 있는 동안 계속 갱신되므로 마지막 시각이 그 작업의 때다.
          occurredAt: Math.floor(Number(composer?.createdAt ?? updatedAt) / MS),
          updatedAtMs: updatedAt,
          paths,
        });
      }
      return out.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    } finally {
      db.close();
    }
  }
}
