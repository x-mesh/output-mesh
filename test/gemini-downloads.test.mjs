import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadGeminiUrl, geminiDownloadUrl, geminiDriveId, geminiFileExtension, loadGeminiRemote, validateGeminiFile } from '../lib/gemini-downloads.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-download-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('restricts download addresses and validates file signatures', () => {
  expect(geminiDownloadUrl('http://lh3.googleusercontent.com/a')).toBeNull();
  expect(geminiDownloadUrl('https://127.0.0.1/private')).toBeNull();
  expect(geminiDownloadUrl('https://lh3.googleusercontent.com.evil.invalid/a')).toBeNull();
  expect(geminiDownloadUrl('https://user:password@lh3.googleusercontent.com/a')).toBeNull();
  expect(geminiDriveId('https://docs.google.com/document/d/document1/edit')).toBe('document1');
  expect(geminiFileExtension('misnamed.md', 'application/pdf')).toBe('pdf');
  expect(geminiFileExtension('report.md', 'text/plain')).toBe('md');
  expect(() => validateGeminiFile(Buffer.from('<!doctype html><html>Login</html>'), 'pdf')).toThrow();
  expect(() => validateGeminiFile(Buffer.from('<!doctype html><html>Login</html>'), 'md')).toThrow();
});

test('downloads image bytes and rejects redirects outside Google hosts', async () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const reference = { url: 'https://lh3.googleusercontent.com/gg/generated', image: true };
  const result = await downloadGeminiUrl(reference, async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } }));
  expect(result.extension).toBe('png'); expect(result.body).toEqual(png);
  await expect(downloadGeminiUrl(reference, async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }))).rejects.toThrow();
  await expect(downloadGeminiUrl(reference, async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }))).rejects.toThrow();
});

test('rejects truncated and oversized remote responses', async () => {
  const reference = { url: 'https://contribution.usercontent.google.com/download', extension: 'md' };
  await expect(downloadGeminiUrl(reference, async () => new Response('# Short', { headers: { 'content-length': '100' } }))).rejects.toThrow();
  await expect(downloadGeminiUrl(reference, async () => new Response('# Short', { headers: { 'content-length': String(17 * 1024 * 1024) } }))).rejects.toThrow();
});

test.each([
  ['application/vnd.google-apps.document', 'text/markdown', 'md', Buffer.from('# Original document')],
  ['application/vnd.google-apps.spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', Buffer.from('504b030400000000', 'hex')],
  ['application/vnd.google-apps.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx', Buffer.from('504b030400000000', 'hex')],
])('exports %s with the authenticated gws command', async (mime, exportMime, extension, body) => {
  const calls = [];
  const run = async (command, args) => {
    expect(command).toBe('gws'); calls.push(args);
    if (args[2] === 'get') return { stdout: JSON.stringify({ id: 'document1', name: 'Report', mimeType: mime, modifiedTime: 'version1' }) };
    expect(JSON.parse(args[args.indexOf('--params') + 1])).toEqual({ fileId: 'document1', mimeType: exportMime });
    writeFileSync(args[args.indexOf('--output') + 1], body); return { stdout: '' };
  };
  const result = await loadGeminiRemote({ driveId: 'document1' }, dir, null, run);
  expect(result.body).toEqual(body); expect(result.extension).toBe(extension); expect(calls).toHaveLength(2);
  expect(readdirSync(dir)).toEqual([]);
  const unchanged = await loadGeminiRemote({ driveId: 'document1' }, dir, { revision: 'version1', extension }, run);
  expect(unchanged.unchanged).toBe(true); expect(calls).toHaveLength(3);
});

test('downloads binary Drive outputs without converting their bytes', async () => {
  const pdf = Buffer.from('%PDF-1.7\n%%EOF');
  const run = async (command, args) => {
    const params = JSON.parse(args[args.indexOf('--params') + 1]);
    if (params.fields) return { stdout: JSON.stringify({ id: 'file1', name: 'Report.pdf', mimeType: 'application/pdf', size: String(pdf.length) }) };
    expect(params).toEqual({ fileId: 'file1', alt: 'media' });
    writeFileSync(args[args.indexOf('--output') + 1], pdf); return { stdout: '' };
  };
  expect((await loadGeminiRemote({ driveId: 'file1' }, dir, null, run)).body).toEqual(pdf);
});

test('removes incomplete downloads and rejects missing Google access', async () => {
  const run = async (command, args) => {
    if (args[2] === 'get') return { stdout: JSON.stringify({ id: 'file1', name: 'Report.md', mimeType: 'application/vnd.google-apps.document' }) };
    writeFileSync(args[args.indexOf('--output') + 1], '# Partial'); throw new Error('download failed');
  };
  await expect(loadGeminiRemote({ driveId: 'file1' }, dir, null, run)).rejects.toThrow();
  expect(readdirSync(dir)).toEqual([]);
  await expect(loadGeminiRemote({ driveId: 'missing' }, join(dir, 'absent'), null, async () => { throw new Error('404'); })).rejects.toThrow();
  expect(existsSync(join(dir, 'absent'))).toBe(false);
});

test('returns sanitized reasons for missing or inaccessible Google files', async () => {
  for (const [status, code] of [[404, 'not_found'], [403, 'access_denied']]) {
    const run = async () => { throw Object.assign(new Error('CANARY_SECRET'), { stdout: JSON.stringify({ error: { code: status, message: 'CANARY_SECRET' } }) }); };
    try { await loadGeminiRemote({ driveId: 'file1' }, dir, null, run); throw new Error('Expected failure'); }
    catch (error) { expect(error.code).toBe(code); expect(error.message).not.toContain('CANARY_SECRET'); }
  }
});
