import { existsSync } from 'node:fs';
import { PEER_CACHE_MS, PEER_PROBE_MS } from './paths.mjs';
import { NAME } from './version.mjs';

/**
 * 노드마다 자기 카탈로그를 `127.0.0.1` 에 띄우고 `tailscale serve` 로 tailnet 에만 낸다. 그래서
 * 바인딩은 지금 그대로고, 인증과 TLS 는 tailnet 이 맡는다. 여기서는 **어디에 있는지만** 모은다 —
 * 산출물도 미리보기도 원래 노드에 남고, 화면은 고른 노드로 통째로 옮겨 간다.
 */
const TAILSCALE_PATHS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale'];

/** 이름은 MagicDNS 이름의 첫 조각이다. HostName 은 "jinwoo의 Mac Studio" 처럼 주소와 다르다. */
const nodeOf = (dnsName) => {
  const host = dnsName.replace(/\.$/, '');
  return { name: host.split('.')[0], url: `https://${host}` };
};

function tailscaleBinary() {
  return TAILSCALE_PATHS.find((path) => existsSync(path)) ?? null;
}

/** tailnet 이 없으면 조용히 빈 목록이다. 이 기능은 있으면 좋은 것이지 카탈로그의 조건이 아니다. */
async function tailnetNodes() {
  const binary = tailscaleBinary();
  if (!binary) return { self: null, nodes: [] };
  try {
    const proc = Bun.spawn([binary, 'status', '--json'], { stdout: 'pipe', stderr: 'ignore' });
    const status = JSON.parse(await new Response(proc.stdout).text());
    const nodes = Object.values(status.Peer ?? {})
      // 꺼진 기기는 물어봐야 시간만 쓴다. 켜져 있어도 output-mesh 가 없으면 아래 probe 가 거른다.
      .filter((peer) => peer.Online && peer.DNSName)
      .map((peer) => nodeOf(peer.DNSName));
    return { self: status.Self?.DNSName ? nodeOf(status.Self.DNSName).name : null, nodes };
  } catch {
    return { self: null, nodes: [] };
  }
}

/** output-mesh 가 도는 노드만 남긴다. 판정은 이 카탈로그가 스스로 밝히는 이름으로 한다. */
export async function probe(node) {
  try {
    const response = await fetch(`${node.url}/api/version`, { signal: AbortSignal.timeout(PEER_PROBE_MS) });
    if (!response.ok) return null;
    const { name, version } = await response.json();
    if (name !== NAME) return null;
    return { ...node, version };
  } catch {
    return null;
  }
}

let cache = { at: 0, value: null };

export async function peers({ now = Date.now } = {}) {
  if (cache.value && now() - cache.at < PEER_CACHE_MS) return cache.value;
  const { self, nodes } = await tailnetNodes();
  const found = (await Promise.all(nodes.map(probe))).filter(Boolean);
  const value = { self, peers: found.sort((a, b) => a.name.localeCompare(b.name)) };
  cache = { at: now(), value };
  return value;
}

/** 테스트와 `/api/sweep` 처럼 방금 바뀐 것을 보려는 곳에서 캐시를 버린다. */
export function forgetPeers() {
  cache = { at: 0, value: null };
}
