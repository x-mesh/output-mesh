import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../lib/store.mjs';
import { ClaudeDesktopReader, parseClaudeCacheEntry } from '../lib/claude-desktop-reader.mjs';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const V7_UUID = '019eb385-b176-77f2-b0e6-05460e2ed404';
const encoder = new TextEncoder();
const envelope = (url, body, headers = {}) => encoder.encode(JSON.stringify({ url, body, headers }));
function simpleCache(url, body, encoding) {
  const key = '1/0/' + url;
  const compressed = encoding === 'gzip' ? gzipSync(body) : encoding === 'br' ? brotliCompressSync(body) : body;
  const nul = String.fromCharCode(0);
  const response = encoder.encode('HTTP/1.1 200' + nul + 'content-type:text/html' + nul + (encoding ? 'content-encoding:' + encoding + nul : '') + nul);
  const keyBytes = encoder.encode(key);
  const bytes = new Uint8Array(24 + keyBytes.length + response.length + compressed.length);
  new DataView(bytes.buffer).setUint32(12, keyBytes.length, true);
  bytes.set(keyBytes, 24); bytes.set(response, 24 + keyBytes.length); bytes.set(compressed, 24 + keyBytes.length + response.length);
  return bytes;
}

function embeddedGzipCache(url, body) {
  const keyBytes = encoder.encode('1/0/' + url);
  const compressed = gzipSync(body);
  const bytes = new Uint8Array(24 + keyBytes.length + compressed.length);
  new DataView(bytes.buffer).setUint32(12, keyBytes.length, true);
  bytes.set(keyBytes, 24);
  bytes.set(compressed, 24 + keyBytes.length);
  return bytes;
}

let dir;
let store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-reader-')); store = new CatalogStore(join(dir, 'catalog.db')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Claude Desktop local cache reader', () => {
  test('allowlists metadata and frame URLs and redacts credential fields', () => {
    const metadata = parseClaudeCacheEntry(envelope('https://claude.ai/api/user_artifacts?token=secret', JSON.stringify({ artifacts: [{ uuid: UUID, title: 'Synthetic', slug: 'demo', version: '2', organization_id: 'private' }] })));
    expect(metadata.records[0]).toMatchObject({ uuid: UUID, title: 'Synthetic', slug: 'demo', version: '2' });
    const body = parseClaudeCacheEntry(envelope('https://claude.ai/api/frame/' + UUID + '?authorization=secret', '<!doctype html><html><body>safe</body></html>'));
    expect(new TextDecoder().decode(body.body)).toContain('<!doctype html>');
    expect(parseClaudeCacheEntry(envelope('https://evil.example/frame/' + UUID, '<!doctype html><html></html>'))).toBeNull();
  });

  test('reads gzip and Brotli bodies and rejects truncated or oversized payloads', () => {
    const html = encoder.encode('<!doctype html><html><body>synthetic</body></html>');
    expect(parseClaudeCacheEntry(simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/7/', html, 'gzip')).body).toBeTruthy();
    expect(parseClaudeCacheEntry(simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/8/', html, 'br')).body).toBeTruthy();
    expect(parseClaudeCacheEntry(simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/9/', html.slice(0, -3)))).toBeNull();
    expect(parseClaudeCacheEntry(envelope('https://' + UUID + '.frame.claudeusercontent.com/_f/10/', 'x'.repeat(100)), { maxBodyBytes: 10 })).toBeNull();
    const embedded = parseClaudeCacheEntry(embeddedGzipCache('https://' + UUID + '.frame.claudeusercontent.com/_f/11/', encoder.encode('<!doctype html><html><title>Embedded</title><body>safe</body></html>')));
    expect(embedded).toMatchObject({ kind: 'frame', uuid: UUID });
    expect(parseClaudeCacheEntry(embeddedGzipCache('https://' + V7_UUID + '.frame.claudeusercontent.com/_f/12/', encoder.encode('<!doctype html><html><body>v7</body></html>')))).toMatchObject({ kind: 'frame', uuid: V7_UUID });
    const oversizedGzip = embeddedGzipCache('https://' + UUID + '.frame.claudeusercontent.com/_f/13/', html);
    new DataView(oversizedGzip.buffer).setUint32(oversizedGzip.length - 4, 101, true);
    expect(parseClaudeCacheEntry(oversizedGzip, { maxBodyBytes: 100 })).toBeNull();
  });

  test('correlates newest complete version and materializes one UUID file', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'metadata'), envelope('https://claude.ai/api/user_artifacts', JSON.stringify({ artifacts: [{ uuid: UUID, title: 'Newest', slug: 'demo', version: '2' }] })));
    writeFileSync(join(cache, 'old'), simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/1/', encoder.encode('<!doctype html><html><body>old</body></html>')));
    writeFileSync(join(cache, 'new'), simpleCache('https://' + UUID + '.frame.claudeusercontent.com/_f/2/', encoder.encode('<!doctype html><html><body>new</body></html>')));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output });
    expect((await reader.artifacts()).artifacts[0].version).toBe('2');
    expect((await reader.sweep(store)).inserted).toBe(1);
    expect(new TextDecoder().decode(readFileSync(join(output, UUID + '.html')))).toContain('new');
    expect(store.db.query('SELECT collector, provider, session_ref FROM artifact_origins').all()).toEqual([{ collector: 'claude-app', provider: 'claude-app', session_ref: UUID }]);
    expect((await reader.sweep(store)).unchanged).toBe(1);
  });

  test('collects a complete frame without metadata and keeps URL fields out of provenance', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    writeFileSync(join(cache, 'frame'), embeddedGzipCache('https://' + UUID + '.frame.claudeusercontent.com/_f/12/?token=secret', encoder.encode('<!doctype html><html><title>Frame title</title><body>safe</body></html>')));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output });
    expect((await reader.artifacts()).artifacts[0]).toMatchObject({ uuid: UUID, title: 'Frame title', pageUrl: null });
    await reader.sweep(store);
    const origin = store.db.query('SELECT prompt, session_title FROM artifact_origins').get();
    expect(origin).toEqual({ prompt: 'version 12', session_title: 'Frame title' });
  });

  test('caches unchanged entries, removes evicted cache records, and keeps managed output', async () => {
    const cache = join(dir, 'Cache_Data'); const output = join(dir, 'managed'); mkdirSync(cache);
    const first = join(cache, 'first'); const second = join(cache, 'second');
    writeFileSync(first, embeddedGzipCache('https://' + UUID + '.frame.claudeusercontent.com/_f/20/', encoder.encode('<!doctype html><html><body>one</body></html>')));
    writeFileSync(second, embeddedGzipCache('https://' + V7_UUID + '.frame.claudeusercontent.com/_f/21/', encoder.encode('<!doctype html><html><body>two</body></html>')));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: output });
    const firstStats = (await reader.artifacts()).stats;
    const secondStats = (await reader.artifacts()).stats;
    expect(firstStats.scanned).toBe(2);
    expect(secondStats.scanned).toBe(0);
    expect(secondStats.skipped).toBe(2);
    await reader.sweep(store);
    unlinkSync(second);
    const afterEviction = await reader.sweep(store);
    expect(afterEviction.found).toBe(1);
    expect(readFileSync(join(output, UUID + '.html'))).toBeTruthy();
    expect(() => readFileSync(join(output, V7_UUID + '.html'))).not.toThrow();
  });

  test('caps metadata payloads, isolates bad entries, and yields during batches', async () => {
    const cache = join(dir, 'Cache_Data'); mkdirSync(cache);
    writeFileSync(join(cache, 'bad'), envelope('https://' + UUID + '.frame.claudeusercontent.com/_f/30/', '<!doctype html><html>truncated'));
    writeFileSync(join(cache, 'large-metadata'), envelope('https://claude.ai/api/user_artifacts', 'x'.repeat(100)));
    for (let i = 0; i < 8; i++) writeFileSync(join(cache, 'entry-' + i), embeddedGzipCache('https://' + (i % 2 ? V7_UUID : UUID) + '.frame.claudeusercontent.com/_f/' + (31 + i) + '/', encoder.encode('<!doctype html><html><body>batch</body></html>')));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: join(dir, 'managed'), batchSize: 1 });
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 0);
    const result = await reader.artifacts();
    expect(result.available).toBe(true);
    expect(result.stats.errors).toBeLessThanOrEqual(1);
    expect(result.stats.found).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timerFired).toBe(true);
    await reader.sweep(store);
    expect(store.getState('claude.last_sweep_code')).toBe('entry_invalid');
  });

  test('keeps an invalid-entry state when no artifact is readable', async () => {
    const cache = join(dir, 'Cache_Data'); mkdirSync(cache);
    writeFileSync(join(cache, 'bad'), envelope('https://' + UUID + '.frame.claudeusercontent.com/_f/40/', '<!doctype html><html>truncated'));
    const reader = new ClaudeDesktopReader({ cacheDataRoot: cache, outputDir: join(dir, 'managed') });
    expect((await reader.sweep(store)).found).toBe(0);
    expect(store.getState('claude.last_sweep_code')).toBe('entry_invalid');
  });
});
