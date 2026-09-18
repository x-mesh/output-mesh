#!/usr/bin/env bun
import { CatalogStore } from '../lib/store.mjs';
import { Watcher } from '../lib/watcher.mjs';
import { asideReaders, sourcesStatus } from '../lib/sources.mjs';
import { collectOnce } from '../lib/collector.mjs';
import { importPath } from '../lib/importer.mjs';
import { startServer } from '../lib/server.mjs';
import { surveyCoverage, REASON_LABEL } from '../lib/coverage.mjs';
import { CATALOG_DB, DEFAULT_HOST, DEFAULT_PORT } from '../lib/paths.mjs';
import { collectProgressText, createSpinner } from '../lib/spinner.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'serve';

function flag(name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
}

const store = new CatalogStore(flag('--db', CATALOG_DB));
const readers = asideReaders();

switch (command) {
  case 'serve': {
    const port = Number(flag('--port', DEFAULT_PORT));
    const watcher = new Watcher(store, readers);
    const spinner = createSpinner();
    if (store.counts().artifacts === 0) {
      spinner.note('처음 실행이라 에이전트 로그를 모두 읽습니다. 로그 양에 따라 몇 분 걸릴 수 있습니다.');
    }
    const started = performance.now();
    spinner.start('수집 준비 중');
    await watcher.start({ onProgress: (progress) => spinner.update(...collectProgressText(progress)) });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    spinner.stop(`수집 완료  ${store.counts().artifacts.toLocaleString('ko-KR')}개 · ${seconds}초`);
    await startServer({ store, watcher, readers }, { port, host: DEFAULT_HOST });
    console.log(`output-mesh  http://${DEFAULT_HOST}:${port}  (${store.counts().artifacts}개 수집됨)`);
    process.on('SIGINT', () => {
      watcher.stop();
      store.close();
      process.exit(0);
    });
    break;
  }

  case 'sweep': {
    for (const reader of readers) console.log(await collectOnce(store, reader));
    console.log(store.counts());
    store.close();
    break;
  }

  case 'import': {
    const target = args[1];
    if (!target) {
      console.error('사용법: output-mesh import <path>');
      process.exit(2);
    }
    console.log(await importPath(store, target));
    store.close();
    break;
  }

  case 'coverage': {
    for (const reader of readers) {
      const survey = surveyCoverage(reader.sessionsRoot);
      console.log(reader.sessionsRoot);
      console.log(`  세션 ${survey.sessions.total}개 — 산출물 있음 ${survey.sessions.withArtifacts}, 비어 있음 ${survey.sessions.empty}`);
      console.log(`  수집 ${survey.collected} / 제외 ${survey.excludedTotal}`);
      for (const [reason, n] of Object.entries(survey.excluded).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(5)}  ${REASON_LABEL[reason] ?? reason}`);
      }
      for (const group of survey.largestGroups) {
        console.log(`  제외된 최대 묶음: ${group.name} (${group.files}개)`);
      }
    }
    store.close();
    break;
  }

  case 'doctor': {
    const { Database } = await import('bun:sqlite');
    const probe = new Database(':memory:');
    let fts5 = false;
    try {
      probe.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')");
      fts5 = true;
    } catch {}
    probe.close();
    console.log({
      catalogDb: store.db.filename,
      journalMode: store.journalMode(),
      fts5Trigram: fts5,
      ftsIntegrity: store.ftsIntegrityOk(),
      counts: store.counts(),
      sources: sourcesStatus(store, readers),
      recentErrors: store.recentIngestEvents(5),
    });
    store.close();
    break;
  }

  default:
    console.error(`알 수 없는 명령: ${command}\n사용법: output-mesh [serve|sweep|import <path>|coverage|doctor] [--port N] [--db PATH]`);
    process.exit(2);
}
