import { existsSync, watch } from 'node:fs';
import { EVENT_RETENTION_DAYS, PERIODIC_SWEEP_MS, WATCH_DEBOUNCE_MS } from './paths.mjs';
import { collectOnce, collectSessionLogs, indexPending, recheckKnownFiles } from './collector.mjs';

const SECONDS_PER_DAY = 86_400;
import { SESSION_LOG_SOURCES } from './session-logs.mjs';

/**
 * 주기 스윕이 정확성을 전담하고 fs.watch 는 체감 지연만 줄인다. recursive 워처가
 * 이벤트를 흘려도 아무것도 깨지지 않는다 — 폴백이 아니라 역할 분리다.
 */
export class Watcher {
  constructor(store, readers, { periodMs = PERIODIC_SWEEP_MS, debounceMs = WATCH_DEBOUNCE_MS, useFsWatch = true, withSessionLogs = true } = {}) {
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
      if (this.withSessionLogs) results.push({ sessionLogs: await collectSessionLogs(this.store, undefined, { onProgress }) });
      // collectOnce 는 Aside 리더마다 돈다. Aside 가 없는 머신에서도 추출 규칙 버전이 바뀌어
      // pending 으로 돌아간 행이 다시 뽑혀야 한다. 비어 있으면 질의 한 번으로 끝난다.
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
      this.emit({ type: 'collected', counts: this.store.counts(), at: now, changes });
      return results;
    } catch (error) {
      this.lastError = String(error.message ?? error);
      this.store.logIngest({ level: 'error', code: 'sweep_failed', message: this.lastError });
      return null;
    } finally {
      this.store.quietEvents = false;
      this.running = false;
    }
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

  status() {
    return {
      sweeps: this.sweepCount,
      watching: this.handles.length,
      lastSweepAt: Number(this.store.getState('aside.last_sweep_at') ?? 0),
      lastError: this.lastError,
    };
  }
}
