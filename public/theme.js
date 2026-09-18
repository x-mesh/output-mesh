// 첫 그림 전에 테마를 정한다. app.js 는 모듈이라 문서를 다 읽은 뒤에 돈다 — 거기서 정하면
// 다크를 고른 사람에게 흰 화면이 한 번 번쩍인다. 그래서 <head> 에서 동기로 불린다.
(() => {
  const KEY = 'aoc.theme';
  const CHOICES = ['system', 'light', 'dark'];
  const media = matchMedia('(prefers-color-scheme: dark)');

  const load = () => {
    try {
      const value = JSON.parse(localStorage.getItem(KEY));
      return CHOICES.includes(value) ? value : 'system';
    } catch {
      return 'system';
    }
  };
  let current = load();

  const apply = () => {
    const dark = current === 'dark' || (current === 'system' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.dispatchEvent(new CustomEvent('themechange', { detail: { choice: current, dark } }));
  };

  globalThis.theme = {
    CHOICES,
    choice: () => current,
    set(choice) {
      current = CHOICES.includes(choice) ? choice : 'system';
      try {
        localStorage.setItem(KEY, JSON.stringify(current));
      } catch {
        // 저장이 막힌 창에서도 이번 화면에는 적용된다. 다음 방문에 시스템 설정으로 돌아갈 뿐이다.
      }
      apply();
    },
  };

  apply();
  // 시스템 설정을 따르는 동안에는 macOS 가 저녁에 다크로 바뀌면 같이 바뀐다.
  media.addEventListener('change', apply);
})();
