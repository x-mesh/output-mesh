import { NPM_LATEST_URL, UPDATE_CHECK_TIMEOUT_MS } from './paths.mjs';

/** 환경 변수로 끈다. 이 조회가 이 프로그램이 스스로 바깥으로 내는 유일한 요청이다. */
export const UPDATE_CHECK_OPT_OUT = 'OUTPUT_MESH_NO_UPDATE_CHECK';

const parts = (version) => String(version).split('-')[0].split('.').map((n) => Number.parseInt(n, 10));

/** latest 가 current 보다 새 버전인가. 해석 못 하면 거짓이다 — 모르는 것을 새 버전이라 알리지 않는다. */
export function isNewer(latest, current) {
  const a = parts(latest);
  const b = parts(current);
  if (a.length < 3 || b.length < 3 || [...a, ...b].some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * npm 레지스트리의 latest 버전. 아무것도 보내지 않는 공개 GET 하나이고, 못 받으면 null 이다.
 * 시작 화면의 보조 안내라 실패를 알리지 않는다 — 안내가 없을 뿐 동작은 그대로다.
 */
export async function latestVersion({ fetchImpl = fetch, env = process.env, timeoutMs = UPDATE_CHECK_TIMEOUT_MS } = {}) {
  if (env[UPDATE_CHECK_OPT_OUT] === '1') return null;
  try {
    const response = await fetchImpl(NPM_LATEST_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const { version } = await response.json();
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}
