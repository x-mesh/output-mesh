import { describe, expect, test } from 'bun:test';
import { UPDATE_CHECK_OPT_OUT, isNewer, latestVersion } from '../lib/update-check.mjs';

const reply = (body, ok = true) => async () => ({ ok, json: async () => body });

describe('새 버전 안내', () => {
  test('숫자로 견준다 — 문자열로 견주면 0.10.0 이 0.9.0 보다 옛 버전이 된다', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.8.1', '0.8.0')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.8.0', '0.8.0')).toBe(false);
    expect(isNewer('0.7.0', '0.8.0')).toBe(false);
  });

  test('해석 못 하는 버전은 새 버전이라 알리지 않는다', () => {
    expect(isNewer('latest', '0.8.0')).toBe(false);
    expect(isNewer('0.9', '0.8.0')).toBe(false);
    expect(isNewer(undefined, '0.8.0')).toBe(false);
  });

  test('레지스트리의 latest 를 읽는다', async () => {
    expect(await latestVersion({ fetchImpl: reply({ version: '0.9.0' }), env: {} })).toBe('0.9.0');
  });

  test('못 받으면 null 이다 — 응답 오류, 형식 오류, 네트워크 실패, 시간 초과', async () => {
    expect(await latestVersion({ fetchImpl: reply({}, false), env: {} })).toBeNull();
    expect(await latestVersion({ fetchImpl: reply({ version: 9 }), env: {} })).toBeNull();
    expect(await latestVersion({ fetchImpl: async () => { throw new Error('offline'); }, env: {} })).toBeNull();
    const hang = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await latestVersion({ fetchImpl: hang, env: {}, timeoutMs: 20 })).toBeNull();
  });

  test('환경 변수로 끄면 요청을 보내지 않는다', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ version: '9.9.9' }) }; };
    expect(await latestVersion({ fetchImpl, env: { [UPDATE_CHECK_OPT_OUT]: '1' } })).toBeNull();
    expect(called).toBe(false);
  });
});
