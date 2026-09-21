import { existsSync } from 'node:fs';
import { PEER_CACHE_MS, PEER_PROBE_MS } from './paths.mjs';
import { NAME } from './version.mjs';

/**
 * 노드마다 자기 카탈로그를 `127.0.0.1` 에 띄우고 `tailscale serve` 로 tailnet 에만 낸다. 그래서
 * 바인딩은 지금 그대로고, 인증과 TLS 는 tailnet 이 맡는다. 여기서는 **어디에 있는지만** 모은다 —
 * 산출물도 미리보기도 원래 노드에 남고, 화면은 고른 노드로 통째로 옮겨 간다.
 *
 * 등록이라는 절차는 없다. 켜져 있는 tailnet 기기에 물어보고 이 카탈로그라고 답하는 곳만 잇는다.
 * 답하지 않는 기기도 **상태와 함께 돌려준다** — 조건을 못 갖춘 노드가 목록에서 그냥 사라지면
 * 무엇이 빠졌는지 알 길이 없다.
 */
const TAILSCALE_PATHS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale'];

export const NODE_STATUS = { SELF: 'self', CONNECTED: 'connected', SILENT: 'silent', OFFLINE: 'offline' };

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
      .filter((peer) => peer.DNSName)
      .map((peer) => ({ ...nodeOf(peer.DNSName), online: Boolean(peer.Online) }));
    return { self: status.Self?.DNSName ? nodeOf(status.Self.DNSName) : null, nodes };
  } catch {
    return { self: null, nodes: [] };
  }
}

/** output-mesh 가 도는 노드만 이어진다. 판정은 이 카탈로그가 스스로 밝히는 이름으로 한다. */
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
  // 꺼진 기기는 물어봐야 시간만 쓴다. 상태만 적어 둔다.
  const answers = await Promise.all(nodes.map((node) => (node.online ? probe(node) : null)));
  const listed = nodes.map((node, at) => {
    const found = answers[at];
    if (found) return { name: node.name, url: node.url, version: found.version, status: NODE_STATUS.CONNECTED };
    return { name: node.name, url: node.url, status: node.online ? NODE_STATUS.SILENT : NODE_STATUS.OFFLINE };
  });
  if (self) listed.unshift({ name: self.name, url: self.url, status: NODE_STATUS.SELF });

  const value = {
    self: self?.name ?? null,
    nodes: listed.sort((a, b) => (a.status === NODE_STATUS.SELF ? -1 : b.status === NODE_STATUS.SELF ? 1 : a.name.localeCompare(b.name))),
    // 화면의 전환기는 이어진 것만 쓴다. 상태가 필요한 곳은 nodes 를 본다.
    peers: listed.filter((node) => node.status === NODE_STATUS.CONNECTED),
  };
  cache = { at: now(), value };
  return value;
}

/** 테스트와 방금 바뀐 것을 보려는 곳에서 캐시를 버린다. */
export function forgetPeers() {
  cache = { at: 0, value: null };
}
