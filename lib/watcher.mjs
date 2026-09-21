import { existsSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { EVENT_RETENTION_DAYS, INGEST_ERROR_VISIBLE_S, PERIODIC_SWEEP_MS, WATCH_DEBOUNCE_MS, WORKSPACE_BACKFILL_DAYS, nfc } from './paths.mjs';
import { collectOnce, collectSessionLogs, indexPending, ingestWorkspaceDoc, recheckKnownFiles, scanWorkspaceDocs, sweepCursor } from './collector.mjs';
import { isWorkspaceDoc, projectWorkspaces } from './workspace-docs.mjs';

const SECONDS_PER_DAY = 86_400;
import { SESSION_LOG_SOURCES } from './session-logs.mjs';
import { resolveWorkspace } from './worktrees.mjs';
import { CursorReader } from './cursor-reader.mjs';

/**
 * 주기 스윕이 정확성을 전담하고 fs.watch 는 체감 지연만 줄인다. recursive 워처가
 * 이벤트를 흘려도 아무것도 깨지지 않는다 — 폴백이 아니라 역할 분리다.
 */
export class Watcher {
  constructor(store, readers, { periodMs = PERIODIC_SWEEP_MS, debounceMs = WATCH_DEBOUNCE_MS, useFsWatch = true, withSessionLogs = true, home = homedir() } = {}) {
    this.store = store;
    this.readers = readers;
    this.periodMs = periodMs;
    this.debounceMs = debounceMs;
    this.useFsWatch = useFsWatch;
    this.withSessionLogs = withSessionLogs;
    this.handles = [];
    this.timer = null;
    this.debounce = null;
    this.running = false;
    this.lastResult = null;
    this.lastError = null;
    this.sweepCount = 0;
    this.listeners = new Set();
    this.lastEventId = store.lastEventId();
    this.home = home;
    // 이 프로세스에서 이미 훑은 작업공간. 훑기는 작업공간마다 한 번이고 그 뒤는 폴더 감시가 맡는다.
    this.scannedWorkspaces = new Set();
    this.rootsSynced = false;
    this.cursorReader = new CursorReader();
    // 폴더 감시가 알려 온 문서. 다음 수집에서 한꺼번에 넣는다.
    this.pendingDocs = new Map();
    // 세션 로그마다 읽은 위치. 로그는 파서 버전이 바뀔 때만 처음부터 다시 읽는데, 그건 재시작이다.
    this.logTails = new Map();
  }

  /** 수집이 한 바퀴 돌 때마다 알린다. 활동 보기가 이걸로 살아난다. */
  onCollect(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(payload) {
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        /* 구독자 하나가 죽어도 수집은 계속된다 */
      }
    }
  }

  /**
   * onProgress 는 서버가 뜨기 전 첫 수집에만 넘긴다. 30초마다 도는 주기 수집과 /api/sweep 은
   * 조용해야 한다 — 여기에 늘 달면 서버가 떠 있는 내내 진행 줄을 찍는다.
   */
  async collect({ onProgress, quiet = false } = {}) {
    if (this.running) return this.lastResult;
    this.running = true;
    this.store.quietEvents = quiet;
    try {
      const results = [];
      for (const reader of this.readers) results.push(await collectOnce(this.store, reader, { onProgress }));
      if (this.withSessionLogs) results.push({ sessionLogs: await collectSessionLogs(this.store, undefined, { onProgress, tails: this.logTails }) });
      // Cursor 는 로그가 아니라 SQLite 라 세션 로그 수집과 별개로 돈다. 없는 머신에서는 바로 빈 결과다.
      if (this.withSessionLogs) results.push({ cursor: await sweepCursor(this.store, this.cursorReader, { onProgress }) });
      // collectOnce 는 Aside 리더마다 돈다. Aside 가 없는 머신에서도 추출 규칙 버전이 바뀌어
      // pending 으로 돌아간 행이 다시 뽑혀야 한다. 비어 있으면 질의 한 번으로 끝난다.
      results.push({ workspaceRoots: this.syncWorkspaceRoots() });
      results.push({ workspaces: await this.collectWorkspaceDocs({ onProgress, quiet }) });
      results.push({ rechecked: await recheckKnownFiles(this.store, { onProgress }) });
      results.push({ indexed: await indexPending(this.store, { onProgress }) });
      const now = Math.floor(Date.now() / 1000);
      this.store.pruneEvents(now - EVENT_RETENTION_DAYS * SECONDS_PER_DAY);
      this.lastResult = results;
      this.lastError = null;
      this.sweepCount++;
      // 화면은 새 변경이 있다는 것만 듣고 목록은 자기 필터로 다시 받는다.
      const changes = this.store.countEventsAfter(this.lastEventId);
      this.lastEventId = Math.max(this.lastEventId, this.store.lastEventId());
      this.emit({ type: 'collected', counts: this.store.counts(), at: now, changes, error: this.recentError(now) });
      return results;
    } catch (error) {
      this.lastError = String(error.message ?? error);
      this.store.logIngest({ level: 'error', code: 'sweep_failed', message: this.lastError });
      // 실패한 수집도 알린다. 아무것도 보내지 않으면 화면은 앞선 "방금 수집"을 그대로 들고 있다.
      this.emit({ type: 'failed', at: Math.floor(Date.now() / 1000), error: this.recentError() });
      return null;
    } finally {
      this.store.quietEvents = false;
      this.running = false;
    }
  }

  /**
   * 작업공간마다 저장소를 찾아 둔다(worktree 는 본 저장소로). 프로세스의 첫 수집은 전부 다시 본다 —
   * 그사이 폴더가 저장소가 됐을 수 있다. 그 뒤로는 처음 보는 작업공간만이라 질의 한 번으로 끝난다.
   */
  syncWorkspaceRoots() {
    const unresolved = new Set(this.store.workspaces({ unresolvedOnly: true }));
    const targets = this.rootsSynced ? [...unresolved] : this.store.workspaces();
    let resolved = 0;
    for (const workspace of targets) {
      // 지워진 worktree 는 다시 풀 수 없다. 전에 찾아 둔 저장소를 자기 자신으로 덮어쓰지 않는다.
      if (!unresolved.has(workspace) && !existsSync(workspace)) continue;
      this.store.setWorkspaceRoot(workspace, resolveWorkspace(workspace, this.home));
      resolved += 1;
    }
    this.rootsSynced = true;
    return resolved;
  }

  /**
   * 작업공간 문서. 새로 알게 된 작업공간은 최근 WORKSPACE_BACKFILL_DAYS 안에 바뀐 문서만 한 번
   * 훑는다. 이 백필은 변경 기록으로 남기지 않는다 — 원래 있던 문서를 처음 알게 된 것이지 방금
   * 일어난 일이 아니다. 그 뒤로 감시가 알려 온 문서는 평소처럼 기록한다.
   */
  async collectWorkspaceDocs({ onProgress, quiet }) {
    const stats = { workspaces: 0, backfilled: 0, changed: 0 };
    const since = Math.floor(Date.now() / 1000) - WORKSPACE_BACKFILL_DAYS * 24 * 60 * 60;
    for (const workspace of projectWorkspaces(this.store, this.home)) {
      stats.workspaces++;
      if (this.scannedWorkspaces.has(workspace)) continue;
      this.scannedWorkspaces.add(workspace);
      this.store.quietEvents = true;
      try {
        stats.backfilled += (await scanWorkspaceDocs(this.store, workspace, { since, onProgress })).ingested;
      } finally {
        this.store.quietEvents = quiet;
      }
      this.watchWorkspace(workspace);
    }
    const pending = [...this.pendingDocs];
    this.pendingDocs.clear();
    for (const [path, workspace] of pending) {
      // 지워진 문서는 다시 확인(recheck)이 사라짐으로 적는다. 여기서는 있는 것만 넣는다.
      if (!existsSync(path)) continue;
      const result = await ingestWorkspaceDoc(this.store, path, workspace);
      if (result.rule === 'inserted' || result.rule === 'updated') stats.changed++;
    }
    return stats;
  }

  watchWorkspace(workspace) {
    if (!this.useFsWatch) return;
    try {
      const handle = watch(workspace, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = nfc(String(filename));
        if (!isWorkspaceDoc(rel)) return;
        this.pendingDocs.set(join(workspace, String(filename)), workspace);
        this.scheduleDebounced();
      });
      this.handles.push(handle);
    } catch (error) {
      this.store.logIngest({ path: workspace, level: 'warn', code: 'watch_unavailable', message: String(error.message ?? error) });
    }
  }

  /** 감시가 없을 때(테스트) 폴더 감시가 알려 온 것과 같은 길로 문서 변경을 넣는다. */
  noteWorkspaceChange(workspace, absPath) {
    if (isWorkspaceDoc(nfc(relative(workspace, absPath)))) this.pendingDocs.set(absPath, workspace);
  }

  scheduleDebounced() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.collect();
    }, this.debounceMs);
  }

  /** 빈 카탈로그의 첫 수집은 모든 파일이 "새로 생김"이다. 피드를 그걸로 채우지 않는다. */
  async start({ onProgress } = {}) {
    await this.collect({ onProgress, quiet: this.store.isEmpty() });
    this.timer = setInterval(() => void this.collect(), this.periodMs);
    if (!this.useFsWatch) return;
    // 세션 로그도 감시한다. 에이전트가 도는 동안 로그가 계속 자라므로 활동이 바로 보인다.
    const roots = [
      ...this.readers.map((reader) => reader.sessionsRoot),
      ...(this.withSessionLogs ? SESSION_LOG_SOURCES.map((source) => source.root) : []),
    ];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        const handle = watch(root, { recursive: true }, () => this.scheduleDebounced());
        this.handles.push(handle);
      } catch (error) {
        // 워처를 못 걸어도 주기 스윕이 정확성을 유지한다. 조용히 넘기지 않고 남긴다.
        this.store.logIngest({ path: root, level: 'warn', code: 'watch_unavailable', message: String(error.message ?? error) });
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    for (const handle of this.handles) handle.close();
    this.handles = [];
    this.timer = null;
    this.debounce = null;
  }

  /**
   * 최근 수집 오류 하나. lastError 는 다음 수집이 성공하면 지워져서, 한 번 난 실패(EISDIR 로 배치가
   * 죽은 일)가 30초 뒤에는 어디에도 보이지 않았다. 수집 기록에서 읽으므로 파일 하나의 실패도 잡힌다.
   */
  recentError(now = Math.floor(Date.now() / 1000)) {
    const found = this.store.recentIngestEvents().find((event) => event.level === 'error' && event.at >= now - INGEST_ERROR_VISIBLE_S);
    return found ? { code: found.code, message: found.message, path: found.path, at: found.at } : null;
  }

  status() {
    return {
      sweeps: this.sweepCount,
      watching: this.handles.length,
      lastSweepAt: Number(this.store.getState('aside.last_sweep_at') ?? 0),
      lastError: this.lastError,
      recentError: this.recentError(),
    };
  }
}
