/**
 * drawio 뷰어를 이 프레임에서 띄운다. 인라인 스크립트 없이 순서를 지키려고 한 파일이 셋을 한다 —
 * 저장소 보정, 뷰어 싣기, 그리기.
 */

/**
 * 이 프레임에는 `allow-same-origin` 이 없어서 오리진이 불투명하다. 그 상태에서는 `localStorage` 를
 * 읽는 것만으로 SecurityError 가 나고 뷰어가 설정을 읽다 멈춘다. 저장할 곳이 없는 건 맞으므로
 * 던지지 않는 빈 저장소를 준다.
 */
try {
  window.localStorage.getItem('probe');
} catch {
  const cells = new Map();
  const shim = {
    get length() {
      return cells.size;
    },
    key: (index) => [...cells.keys()][index] ?? null,
    getItem: (key) => (cells.has(String(key)) ? cells.get(String(key)) : null),
    setItem: (key, value) => {
      cells.set(String(key), String(value));
    },
    removeItem: (key) => {
      cells.delete(String(key));
    },
    clear: () => cells.clear(),
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { value: shim, configurable: true });
  }
}

/**
 * 뷰어가 스스로 도는 `GraphViewer.processElements()` 는 이 프레임에서 아무것도 그리지 않고,
 * 예외를 자기 try 안에서 삼켜 이유도 남기지 않는다(실측: 5초를 기다려도 svg 0개). 그릴 대상이
 * 하나뿐이라 그 하나를 직접 그린다 — 같은 순간에 불러도 바로 나온다.
 */
const viewer = document.createElement('script');
viewer.src = document.currentScript.dataset.viewer;
viewer.onload = () => {
  const target = document.querySelector('.mxgraph');
  if (target) globalThis.GraphViewer.createViewerForElement(target);
};
document.head.appendChild(viewer);
