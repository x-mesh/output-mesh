import { AsideReader } from './aside-reader.mjs';
import { CursorReader } from './cursor-reader.mjs';
import { asideAccountDirs } from './paths.mjs';

export function asideReaders() {
  return asideAccountDirs().map((dir) => new AsideReader(dir));
}

export function sourcesStatus(store, readers) {
  const cursor = new CursorReader();
  return [...readers.map((reader) => ({
    collector: 'aside',
    accountDir: reader.accountDir,
    sessionsRoot: reader.sessionsRoot,
    stateDb: reader.dbPath,
    available: reader.available(),
    turnCursor: Number(store.getState('aside.turn_cursor') ?? 0),
    lastSweepAt: Number(store.getState('aside.last_sweep_at') ?? 0),
  })), {
    collector: 'cursor',
    stateDb: cursor.dbPath,
    available: cursor.available(),
    // 밀리초 커서다. Cursor 는 대화가 살아 있는 동안 lastUpdatedAt 을 계속 민다.
    scannedUntil: Number(store.getState('cursor.scanned_until') ?? 0),
  }];
}
