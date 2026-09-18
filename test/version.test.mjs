import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../lib/version.mjs';

const ROOT = join(import.meta.dir, '..');
const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

describe('버전', () => {
  test('버전의 기준은 package.json 하나다', () => {
    expect(VERSION).toBe(packageVersion);
  });

  test('--version 은 카탈로그를 열지 않고 답한다 — 버전만 물었는데 DB 폴더를 만들면 안 된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'output-mesh-version-'));
    const db = join(dir, 'never', 'catalog.db');
    try {
      for (const flag of ['--version', '-v', 'version']) {
        const proc = Bun.spawn(['bun', join(ROOT, 'bin', 'output-mesh.mjs'), flag, '--db', db], { stdout: 'pipe' });
        expect((await new Response(proc.stdout).text()).trim()).toBe(`output-mesh ${packageVersion}`);
        expect(await proc.exited).toBe(0);
      }
      expect(existsSync(join(dir, 'never'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
