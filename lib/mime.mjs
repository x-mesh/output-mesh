const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', tiff: 'image/tiff', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
};

export function mimeFor(ext) {
  return TYPES[ext] ?? 'application/octet-stream';
}

/**
 * 에이전트가 만든 HTML 을 띄울 때의 최소 권한. connect-src 'none' 이 비컨 구멍을 닫고,
 * 스크립트 허용 여부와 무관하게 유지된다 — 로컬 전용이라는 약속은 협상 대상이 아니다.
 */
export function artifactCsp(allowScripts) {
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    allowScripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "font-src 'self' data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}
