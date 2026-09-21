import { homedir } from 'node:os';
import { join } from 'node:path';
import { NAME } from './version.mjs';

/**
 * 상시로 띄우는 일은 운영체제가 이미 한다 — 로그아웃을 넘기고, 죽으면 다시 띄우고, 로그를 받는다.
 * 여기서는 그 설정 파일과 부를 명령만 만든다. 계획을 순수 함수로 두는 이유는 테스트가 실제
 * LaunchAgents 폴더를 건드리지 않게 하려는 것이다.
 */
export const SERVICE_LABEL = 'com.xmesh.output-mesh';

/** `bunx` 는 실행마다 캐시에 풀어서 그 경로가 다음 부팅에 남아 있지 않다. 서비스가 조용히 안 뜬다. */
const EPHEMERAL = [`/.bun/install/cache/`, '/private/var/folders/', '/tmp/'];

export function looksEphemeral(scriptPath) {
  return EPHEMERAL.some((mark) => scriptPath.includes(mark));
}

const escapeXml = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function launchd({ home, command, uid }) {
  const target = `gui/${uid}/${SERVICE_LABEL}`;
  const path = join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const log = join(home, 'Library', 'Logs', `${NAME}.log`);
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((part) => `    <string>${escapeXml(part)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict></plist>
`;
  return {
    kind: 'launchd',
    path,
    log,
    contents,
    // 켜고 끄는 단위가 "불러들였는가"다. KeepAlive 가 켜져 있어 죽이기만 하면 곧바로 되살아난다.
    load: [['launchctl', 'bootstrap', `gui/${uid}`, path]],
    unload: [['launchctl', 'bootout', target]],
    restart: [['launchctl', 'kickstart', '-k', target]],
    status: [['launchctl', 'print', target]],
  };
}

function systemd({ home, command }) {
  const unit = `${NAME}.service`;
  const path = join(home, '.config', 'systemd', 'user', unit);
  const contents = `[Unit]
Description=${NAME}
After=network-online.target

[Service]
ExecStart=${command.map((part) => JSON.stringify(part)).join(' ')}
Restart=always

[Install]
WantedBy=default.target
`;
  return {
    kind: 'systemd',
    path,
    log: `journalctl --user -u ${unit}`,
    contents,
    load: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', unit]],
    unload: [['systemctl', '--user', 'disable', '--now', unit]],
    restart: [['systemctl', '--user', 'restart', unit]],
    status: [['systemctl', '--user', 'status', unit]],
  };
}

/** 지원하지 않는 곳에서는 만들지 않는다 — 반쯤 맞는 설정 파일을 남기는 것보다 안 쓰는 게 낫다. */
export function servicePlan({ platform = process.platform, home = homedir(), uid = process.getuid?.() ?? 0, command }) {
  if (platform === 'darwin') return launchd({ home, command, uid });
  if (platform === 'linux') return systemd({ home, command });
  return null;
}

/** 서비스가 부를 명령. 지금 이 프로세스를 그대로 다시 부르되 `serve` 로 고정한다. */
export function serviceCommand({ execPath = process.execPath, script, args = [] }) {
  return [execPath, script, 'serve', ...args];
}
