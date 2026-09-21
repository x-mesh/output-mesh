#!/usr/bin/env bun
import { CatalogStore } from '../lib/store.mjs';
import { Watcher } from '../lib/watcher.mjs';
import { asideReaders, sourcesStatus } from '../lib/sources.mjs';
import { collectOnce } from '../lib/collector.mjs';
import { importPath } from '../lib/importer.mjs';
import { startServer } from '../lib/server.mjs';
import { surveyCoverage, REASON_LABEL } from '../lib/coverage.mjs';
import { CATALOG_DB, COMPACT_HINT_RATIO, DEFAULT_HOST, DEFAULT_PORT, INGEST_ERROR_VISIBLE_S, MEGABYTE } from '../lib/paths.mjs';
import { collectProgressText, count, createSpinner } from '../lib/spinner.mjs';
import { NAME, VERSION } from '../lib/version.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'serve';

// 버전만 물었는데 카탈로그를 열면 DB 폴더를 만들고 스키마를 고친다. 그 전에 답하고 끝낸다.
if (['--version', '-v', 'version'].includes(command)) {
  console.log(`${NAME} ${VERSION}`);
  process.exit(0);
}

function flag(name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
}

/**
 * 시작 화면. 무엇이 모였고 무엇을 하면 되는지만 적는다 — 주소를 눈에 띄게 두는 것이 이 화면의
 * 일이다. 볼 것이 있을 때만 줄을 늘린다(빠진 수집기, 회수할 빈 자리, 지난 오류).
 */
function startupLines(store, readers, port) {
  const counts = store.counts();
  const storage = store.storage();
  const sources = sourcesStatus(store, readers);
  const missing = sources.filter((source) => !source.available).map((source) => source.collector);
  // 지난 오류까지 붙들지 않는다. 화면이 쓰는 것과 같은 창(INGEST_ERROR_VISIBLE_S)으로 자른다.
  const since = Math.floor(Date.now() / 1000) - INGEST_ERROR_VISIBLE_S;
  const errors = store.recentIngestEvents().filter((event) => event.level === 'error' && event.at >= since).length;

  const lines = [
    `${NAME} ${VERSION}`,
    '',
    `  Catalog   ${count(counts.artifacts)} artifacts · ${count(counts.final)} final · ${count(counts.origins)} origins`,
  ];
  if (missing.length > 0) lines.push(`  Missing   ${missing.join(', ')} — not installed on this machine`);
  if (storage.freeRatio >= COMPACT_HINT_RATIO) {
    lines.push(`  Storage   ${mb(storage.freeBytes)} of ${mb(storage.bytes)} is reclaimable — run \`${NAME} compact\``);
  }
  if (errors > 0) lines.push(`  Errors    ${count(errors)} collect errors in the last hour — run \`${NAME} doctor\``);
  lines.push('', `  Open      http://${DEFAULT_HOST}:${port}`, '  Stop      Ctrl-C', '');
  return lines;
}

const mb = (bytes) => `${(bytes / MEGABYTE).toFixed(1)}MB`;

const store = new CatalogStore(flag('--db', CATALOG_DB));
const readers = asideReaders();

switch (command) {
  case 'serve': {
    const port = Number(flag('--port', DEFAULT_PORT));
    const watcher = new Watcher(store, readers);
    const spinner = createSpinner();
    if (store.counts().artifacts === 0) {
      spinner.note('First run: reading every agent log. This can take a few minutes.');
    }
    const started = performance.now();
    spinner.start('Preparing to collect');
    await watcher.start({ onProgress: (progress) => spinner.update(...collectProgressText(progress)) });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    spinner.stop(`Collected in ${seconds}s`);
    try {
      await startServer({ store, watcher, readers }, { port, host: DEFAULT_HOST });
    } catch (error) {
      // 다른 포트로 몰래 옮기지 않는다. 같은 카탈로그에 두 서버가 붙으면 쓰기가 서로 막혀
      // 수집이 'database is locked' 로 죽는다 — 실제로 그렇게 기록됐다.
      console.error(error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Stop the other instance, or pick another port:\n  ${NAME} serve --port ${port + 1}`
        : `Could not start the server: ${error.message}`);
      watcher.stop();
      store.close();
      process.exit(1);
    }
    // 서버가 뜬 다음에만 주소를 적는다. 먼저 적으면 뜨지 못했을 때 죽은 주소를 권하게 된다.
    for (const line of startupLines(store, readers, port)) console.log(line);
    process.on('SIGINT', () => {
      watcher.stop();
      store.close();
      process.exit(0);
    });
    break;
  }

  case 'sweep': {
    // 빈 카탈로그의 첫 수집은 모든 파일이 "새로 생김"이다. 변경 기록을 그걸로 채우지 않는다.
    store.quietEvents = store.isEmpty();
    for (const reader of readers) console.log(await collectOnce(store, reader));
    store.quietEvents = false;
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
      version: VERSION,
      catalogDb: store.db.filename,
      journalMode: store.journalMode(),
      storage: store.storage(),
      fts5Trigram: fts5,
      ftsIntegrity: store.ftsIntegrityOk(),
      counts: store.counts(),
      sources: sourcesStatus(store, readers),
      recentErrors: store.recentIngestEvents(5),
    });
    store.close();
    break;
  }

  case 'compact': {
    const started = Date.now();
    const { before, after } = store.compact();
    const mb = (bytes) => `${(bytes / MEGABYTE).toFixed(1)}MB`;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${mb(before)} → ${mb(after)}  (${mb(before - after)} 회수 · ${seconds}초)`);
    store.close();
    break;
  }

  default:
    console.error(`알 수 없는 명령: ${command}\n사용법: output-mesh [serve|sweep|import <path>|coverage|doctor|compact|--version] [--port N] [--db PATH]`);
    process.exit(2);
}
