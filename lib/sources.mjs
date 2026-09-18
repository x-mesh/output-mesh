import { AsideReader } from './aside-reader.mjs';
import { asideAccountDirs } from './paths.mjs';

export function asideReaders() {
  return asideAccountDirs().map((dir) => new AsideReader(dir));
}

export function sourcesStatus(store, readers) {
  return readers.map((reader) => ({
    collector: 'aside',
    accountDir: reader.accountDir,
    sessionsRoot: reader.sessionsRoot,
    stateDb: reader.dbPath,
    available: reader.available(),
    turnCursor: Number(store.getState('aside.turn_cursor') ?? 0),
    lastSweepAt: Number(store.getState('aside.last_sweep_at') ?? 0),
  }));
}
