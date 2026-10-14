import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const GEMINI_DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024;
const GOOGLE_EXPORTS = new Map([
  ['application/vnd.google-apps.document', { mime: 'text/markdown', extension: 'md' }],
  ['application/vnd.google-apps.spreadsheet', { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' }],
  ['application/vnd.google-apps.presentation', { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: 'pptx' }],
]);
const MIME_EXTENSIONS = new Map([
  ['text/markdown', 'md'], ['text/plain', 'txt'], ['text/csv', 'csv'],
  ['application/pdf', 'pdf'], ['image/png', 'png'], ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'], ['image/gif', 'gif'], ['image/svg+xml', 'svg'],
  ['image/tiff', 'tiff'], ['image/bmp', 'bmp'], ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'], ['image/heic', 'heic'], ['image/avif', 'avif'],
  ['application/rtf', 'rtf'], ['text/rtf', 'rtf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/msword', 'doc'], ['application/vnd.ms-excel', 'xls'], ['application/vnd.ms-powerpoint', 'ppt'],
  ['application/vnd.oasis.opendocument.text', 'odt'], ['application/vnd.oasis.opendocument.spreadsheet', 'ods'], ['application/vnd.oasis.opendocument.presentation', 'odp'],
]);
const SUPPORTED_EXTENSIONS = new Set([...MIME_EXTENSIONS.values(), 'markdown', 'jpeg', 'html', 'hwp', 'hwpx', 'key', 'pages', 'numbers']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'tiff', 'bmp', 'ico', 'heic', 'avif']);

export function geminiFileExtension(name, mime = '') {
  const exported = GOOGLE_EXPORTS.get(mime);
  if (exported) return exported.extension;
  const extension = String(name).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (mime !== 'text/plain' && MIME_EXTENSIONS.has(mime)) return MIME_EXTENSIONS.get(mime);
  if (extension && SUPPORTED_EXTENSIONS.has(extension)) return extension;
  return MIME_EXTENSIONS.get(mime) ?? null;
}

export function geminiDownloadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!['docs.google.com', 'drive.google.com', 'drive.usercontent.google.com', 'contribution.usercontent.google.com'].includes(url.hostname)
      && !url.hostname.endsWith('.googleusercontent.com')) return null;
    return url.toString();
  } catch { return null; }
}

export function geminiDriveId(value) {
  const allowed = geminiDownloadUrl(value);
  if (!allowed) return null;
  const url = new URL(allowed);
  if (url.hostname === 'docs.google.com') return url.pathname.match(/^\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] ?? null;
  if (url.hostname === 'drive.google.com') {
    const id = url.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] ?? url.searchParams.get('id');
    return id && /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
  }
  return null;
}

export function validateGeminiFile(input, extension) {
  const bytes = Buffer.from(input);
  if (!SUPPORTED_EXTENSIONS.has(extension) || !bytes.length || bytes.length > GEMINI_DOWNLOAD_MAX_BYTES) throw new Error('Invalid Gemini output size or type.');
  const starts = (hex) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  let valid = true;
  if (extension === 'pdf') valid = bytes.subarray(0, 5).toString() === '%PDF-';
  else if (extension === 'png') valid = starts('89504e470d0a1a0a');
  else if (['jpg', 'jpeg'].includes(extension)) valid = starts('ffd8ff');
  else if (extension === 'webp') valid = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  else if (extension === 'gif') valid = /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString());
  else if (extension === 'tiff') valid = starts('49492a00') || starts('4d4d002a');
  else if (extension === 'bmp') valid = bytes.subarray(0, 2).toString() === 'BM';
  else if (extension === 'ico') valid = starts('00000100');
  else if (['heic', 'avif'].includes(extension)) valid = bytes.subarray(4, 8).toString() === 'ftyp';
  else if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'hwpx', 'key', 'pages', 'numbers'].includes(extension)) valid = starts('504b0304');
  else if (['doc', 'xls', 'ppt', 'hwp'].includes(extension)) valid = starts('d0cf11e0a1b11ae1');
  else if (extension === 'rtf') valid = bytes.subarray(0, 5).toString() === '{\\rtf';
  else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    valid = !text.includes('\0');
    if (extension === 'svg') valid &&= /<svg\b/i.test(text);
    else if (extension !== 'html') valid &&= !/^\s*<!doctype\s+html|^\s*<html\b/i.test(text);
  }
  if (!valid) throw new Error('Gemini download does not match its file type.');
  return bytes;
}

async function googleFile(reference, outputDir, previous, run) {
  const params = { fileId: reference.driveId, fields: 'id,name,mimeType,modifiedTime,size' };
  const { stdout } = await run('gws', ['drive', 'files', 'get', '--params', JSON.stringify(params)], { timeout: 10_000, maxBuffer: 64 * 1024 });
  const metadata = JSON.parse(stdout);
  if (metadata.id !== reference.driveId || !metadata.mimeType) throw new Error('Invalid Google file metadata.');
  const exportType = GOOGLE_EXPORTS.get(metadata.mimeType);
  const extension = geminiFileExtension(metadata.name, metadata.mimeType);
  if (!extension || Number(metadata.size ?? 0) > GEMINI_DOWNLOAD_MAX_BYTES) throw new Error('Unsupported Google file type or size.');
  if (metadata.modifiedTime && previous?.revision === metadata.modifiedTime && previous.extension === extension) return { unchanged: true, extension, revision: metadata.modifiedTime };
  mkdirSync(outputDir, { recursive: true });
  const temporary = mkdtempSync(join(outputDir, '.download-'));
  const target = join(temporary, 'body');
  try {
    const method = exportType ? 'export' : 'get';
    const request = exportType ? { fileId: reference.driveId, mimeType: exportType.mime } : { fileId: reference.driveId, alt: 'media' };
    await run('gws', ['drive', 'files', method, '--params', JSON.stringify(request), '--output', target], { timeout: 20_000, maxBuffer: 64 * 1024 });
    if (statSync(target).size > GEMINI_DOWNLOAD_MAX_BYTES) throw new Error('Google download exceeds size limit.');
    return { body: validateGeminiFile(readFileSync(target), extension), extension, revision: metadata.modifiedTime ?? null };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export async function downloadGeminiUrl(reference, fetcher = fetch) {
  let url = geminiDownloadUrl(reference.url);
  if (!url) throw new Error('Unsupported Gemini download address.');
  let extension = reference.extension ?? geminiFileExtension(reference.name, reference.mime);
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetcher(url, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      url = location ? geminiDownloadUrl(new URL(location, url).toString()) : null;
      if (!url) throw new Error('Unsupported Gemini download redirect.');
      continue;
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > GEMINI_DOWNLOAD_MAX_BYTES) {
      await response.body?.cancel(); throw new Error('Gemini download failed or exceeds size limit.');
    }
    extension ??= geminiFileExtension('', response.headers.get('content-type')?.split(';')[0].trim());
    if (!extension || (reference.image && !IMAGE_EXTENSIONS.has(extension))) {
      await response.body.cancel(); throw new Error('Unsupported Gemini download type.');
    }
    const reader = response.body.getReader(); const parts = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > GEMINI_DOWNLOAD_MAX_BYTES) throw new Error('Gemini download exceeds size limit.');
        parts.push(value);
      }
      const declared = response.headers.get('content-length');
      if (declared && !response.headers.get('content-encoding') && size !== Number(declared)) throw new Error('Truncated Gemini download.');
      return { body: validateGeminiFile(Buffer.concat(parts), extension), extension };
    } finally { await reader.cancel(); }
  }
  throw new Error('Too many Gemini download redirects.');
}

export async function loadGeminiRemote(reference, outputDir, previous, run = execute) {
  try { return await (reference.driveId ? googleFile(reference, outputDir, previous, run) : downloadGeminiUrl(reference)); }
  catch (error) {
    let status;
    if (typeof error.stdout === 'string') { try { status = JSON.parse(error.stdout).error?.code; } catch {} }
    const code = error.code === 'ENOENT' ? 'gws_unavailable' : status === 404 ? 'not_found' : [401, 403].includes(status) ? 'access_denied' : 'download_failed';
    throw Object.assign(new Error('Gemini output download failed.'), { code });
  }
}
