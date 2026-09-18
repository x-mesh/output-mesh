import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { MAX_ARTIFACT_BYTES } from './paths.mjs';

export const HASH_SKIPPED_TOO_LARGE = 'too-large';
export const HASH_UNSTABLE = 'unstable';

export function fileIdOf(stat) {
  return `${stat.dev}:${stat.ino}`;
}

/**
 * 해싱 도중 파일이 바뀌면 존재한 적 없는 해시가 기록된다. 전후 stat 이 다르면 버리고
 * 다음 스윕에 맡긴다 — 부분적으로 쓰인 파일을 성공으로 위장하지 않기 위해서다.
 */
export async function hashFile(absPath) {
  const before = statSync(absPath);
  if (before.size > MAX_ARTIFACT_BYTES) return { hash: null, skipped: HASH_SKIPPED_TOO_LARGE, stat: before };

  const digest = createHash('sha256');
  for await (const chunk of createReadStream(absPath)) digest.update(chunk);

  const after = statSync(absPath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    return { hash: null, skipped: HASH_UNSTABLE, stat: after };
  }
  return { hash: digest.digest('hex'), skipped: null, stat: after };
}
