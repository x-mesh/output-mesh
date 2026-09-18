import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REJECT } from '../lib/scanner.mjs';
import { KIND } from '../lib/extract.mjs';
import { PERIOD_DAYS } from '../lib/paths.mjs';

const PUBLIC = join(import.meta.dir, '..', 'public');
const read = (name) => readFileSync(join(PUBLIC, name), 'utf8');
const HANGUL = /[가-힣]/;

let MESSAGES;
beforeAll(async () => {
  // i18n.js 는 브라우저 스크립트다. 필요한 전역만 흉내 내어 사전을 꺼낸다.
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.navigator = { languages: ['en-US'] };
  globalThis.document = { documentElement: { dataset: {} }, querySelectorAll: () => [], dispatchEvent() {} };
  globalThis.CustomEvent = class {};
  await import('../public/i18n.js');
  ({ MESSAGES } = globalThis.i18n);
});

const params = { n: 2, total: 5, name: 'Codex', label: 'x', path: '/w', date: 'd', when: 'w', period: 'p', day: 'd', hour: 3, title: 't', reason: 'r', withArtifacts: 1, empty: 1, current: 'a', next: 'b', kind: 'Code', version: '1.0.0', rows: 3, cols: 2 };

describe('다국어 사전', () => {
  test('두 언어의 키가 짝이 맞고 모든 문구가 글자로 나온다', () => {
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES.ko).sort());
    for (const lang of ['ko', 'en']) {
      for (const [key, message] of Object.entries(MESSAGES[lang])) {
        const text = typeof message === 'function' ? message(params) : message;
        expect([lang, key, typeof text, text.length > 0]).toEqual([lang, key, 'string', true]);
      }
    }
  });

  test('영어 사전에 한글이 섞이지 않는다', () => {
    for (const [key, message] of Object.entries(MESSAGES.en)) {
      const text = typeof message === 'function' ? message(params) : message;
      expect([key, HANGUL.test(text)]).toEqual([key, false]);
    }
  });

  test('영어는 하나와 여럿을 가른다', () => {
    expect(MESSAGES.en['summary.count']({ n: 1 })).toBe('1 item');
    expect(MESSAGES.en['summary.count']({ n: 3 })).toBe('3 items');
  });

  test('코드와 index.html 이 부르는 키가 모두 사전에 있다 — 빠지면 화면에 키가 그대로 보인다', () => {
    const app = read('app.js');
    const html = read('index.html');
    const literal = [...app.matchAll(/\bt(?:Or)?\('([\w.-]+)'/g)].map((m) => m[1]);
    const ternary = [...app.matchAll(/\bt\([^)]*?\?\s*'([\w.-]+)'\s*:\s*'([\w.-]+)'/g)].flatMap((m) => [m[1], m[2]]);
    const html1 = [...html.matchAll(/data-i18n="([\w.-]+)"/g)].map((m) => m[1]);
    const html2 = [...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((pair) => pair.split(':')[1]));
    // 값에서 만들어지는 키: 값의 목록은 서버 쪽 정의에서 가져온다.
    const families = [
      ...[...Object.keys(PERIOD_DAYS), 'all'].flatMap((p) => [`period.${p}`, `periodTitle.${p}`, `periodName.${p}`]),
      ...['hour', 'day', 'week'].map((u) => `unit.${u}`),
      ...['repo', 'provider', 'collector', 'date', 'kind'].map((g) => `group.${g}`),
      ...[...Object.values(KIND), 'bundle', 'unclassified'].map((k) => `kind.${k}`),
      ...Object.values(REJECT).map((r) => `reason.${r}`),
      ...['indexed', 'skipped', 'failed', 'pending', 'none'].map((s) => `bodyState.${s}`),
      ...['system', 'light', 'dark'].map((th) => `theme.${th}`),
      ...['discovered', 'final'].map((s) => `state.${s}`),
      ...['doc', 'task'].map((s) => `subtitle.${s}`),
    ];
    const missing = [...new Set([...literal, ...ternary, ...html1, ...html2, ...families])].filter((key) => !(key in MESSAGES.ko));
    expect(missing).toEqual([]);
  });

  test('app.js 에 번역되지 않은 한국어 문구가 남지 않는다 — 주석과 언어 이름만 예외', () => {
    const code = read('app.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
      .join('\n');
    const strings = [...code.matchAll(/'([^'\n]*)'|`([^`]*)`|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const leftovers = strings.filter((s) => HANGUL.test(s) && s !== '한국어');
    expect(leftovers).toEqual([]);
  });
});
