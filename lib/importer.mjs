import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nfc } from './paths.mjs';
import { ingestFile, reindexArtifact } from './collector.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.build', 'target', 'dist', '.next', '__pycache__', '.venv']);
const MAX_IMPORT_FILES = 5000;

function walk(root, out) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (out.length >= MAX_IMPORT_FILES) return;
    if (entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path, out);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
}

/**
 * 브라우저는 절대 경로를 주지 않고 <input type="file"> 은 바이트를 복사한다. 그래서
 * 가져오기는 CLI 와 서버측 탐색기 두 경로만 쓴다 — 원본은 참조만 하고 복사하지 않는다.
 */
export async function importPath(store, rawPath) {
  const target = nfc(rawPath);
  if (!target || !existsSync(target)) throw new Error(`경로가 없습니다: ${target}`);

  const stat = statSync(target);
  const files = [];
  if (stat.isDirectory()) walk(target, files);
  else if (stat.isFile()) files.push(target);
  else throw new Error('파일이나 디렉터리가 아닙니다');

  const workspace = stat.isDirectory() ? target : null;
  const stats = { scanned: 0, inserted: 0, updated: 0, touched: 0, relocated: 0, skipped: 0, truncated: files.length >= MAX_IMPORT_FILES };

  for (const absPath of files) {
    stats.scanned++;
    const result = await ingestFile(store, absPath, { collector: 'import', workspace, createdAt: Math.floor(statSync(absPath).mtimeMs / 1000) });
    if (result.rule in stats) stats[result.rule]++;
    else stats.skipped++;
    if (result.id) await reindexArtifact(store, result.id);
  }
  return stats;
}
