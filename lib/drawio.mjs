/**
 * `.drawio` 는 압축 없는 `<mxfile>` XML 이라 공식 뷰어로 그대로 그려진다. 그리는 쪽은 여전히
 * 에이전트가 만든 내용이므로 아티팩트 HTML 과 같은 울타리 안에 둔다 — `allow-same-origin` 없는
 * iframe, `connect-src 'none'`. 편집기는 싣지 않는다(읽기 전용).
 */
export const DRAWIO_VIEWER_SRC = '/vendor/drawio-viewer.min.js';
/** 뷰어보다 먼저 돈다. 불투명 오리진에서 저장소 접근이 터지는 것을 막는다. */
export const DRAWIO_FRAME_SRC = '/drawio-frame.js';

/**
 * 스크립트 출처를 `'self'` 가 아니라 실제 주소로 적는다. 샌드박스 문서는 오리진이 불투명이라
 * `'self'` 가 무엇과도 맞지 않을 수 있고, 그러면 뷰어가 조용히 안 뜬다.
 */
export function drawioCsp(origin) {
  return [
    "default-src 'none'",
    `script-src ${origin}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

const escapeAttr = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function drawioPage(xml, { theme = 'light' } = {}) {
  // 도구막대에 편집·저장을 주지 않는다. 페이지 이동과 확대만 있으면 읽는 데 충분하다.
  const config = {
    xml,
    nav: true,
    resize: true,
    toolbar: 'pages zoom layers',
    'toolbar-position': 'top',
    highlight: '#0a66d0',
    lightbox: false,
  };
  const background = theme === 'dark' ? '#1c1c1e' : '#fff';
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">`
    + `<style>html,body{margin:0;height:100%;background:${background};overflow:hidden}`
    + `.mxgraph{width:100%;height:100%}</style></head><body>`
    + `<div class="mxgraph" data-mxgraph="${escapeAttr(JSON.stringify(config))}"></div>`
    + `<script src="${DRAWIO_FRAME_SRC}" data-viewer="${DRAWIO_VIEWER_SRC}"></script></body></html>`;
}
