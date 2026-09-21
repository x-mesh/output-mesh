/**
 * `.drawio` 는 압축 없는 `<mxfile>` XML 이라 공식 뷰어로 그대로 그려진다. 그리는 쪽은 여전히
 * 에이전트가 만든 내용이므로 아티팩트 HTML 과 같은 울타리 안에 둔다 — `allow-same-origin` 없는
 * iframe, `connect-src 'none'`. 편집기는 싣지 않는다(읽기 전용).
 *
 * 도형 이미지만은 예외로 바깥에서 받는다. 실측 306개 중 221건이 drawio 서버의 상대경로이고
 * 195건이 절대 주소라, 막으면 구성도의 아이콘이 통째로 빈 칸이 된다. 문서를 여는 순간 그 주소로
 * 요청이 나가고 주소는 문서를 만든 쪽이 정한다는 뜻이므로, 이미지 말고는 아무것도 열지 않는다.
 */
export const DRAWIO_IMAGE_BASE = 'https://app.diagrams.net/';
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
    // 도형 아이콘만 바깥을 허용한다. connect-src 는 닫혀 있어 스크립트는 여전히 못 부른다.
    'img-src data: https:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

const escapeAttr = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * `image=img/lib/…` 는 drawio 가 자기 서버에 두는 기본 도형이다. 그대로 두면 우리 주소를 기준으로
 * 풀려 404 가 되므로(실측 221건) 원래 자리로 돌린다.
 */
export function absoluteShapeImages(xml) {
  return xml.replace(/image=img\//g, `image=${DRAWIO_IMAGE_BASE}img/`);
}

export function drawioPage(xml, { theme = 'light' } = {}) {
  // 도구막대에 편집·저장을 주지 않는다. 페이지 이동과 확대만 있으면 읽는 데 충분하다.
  const config = {
    xml: absoluteShapeImages(xml),
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
