import { describe, expect, test } from 'bun:test';
import { SERVICE_LABEL, looksEphemeral, serviceCommand, servicePlan } from '../lib/service.mjs';

const command = serviceCommand({ execPath: '/Users/x/.bun/bin/bun', script: '/Users/x/.bun/install/global/node_modules/output-mesh/bin/output-mesh.mjs' });

describe('상시 실행 설정', () => {
  test('macOS 는 LaunchAgent 를 만들고 로그인마다 띄운다', () => {
    const plan = servicePlan({ platform: 'darwin', home: '/Users/x', uid: 501, command });
    expect(plan.kind).toBe('launchd');
    expect(plan.path).toBe(`/Users/x/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
    expect(plan.contents).toContain('<key>RunAtLoad</key><true/>');
    expect(plan.contents).toContain('<string>/Users/x/.bun/bin/bun</string>');
    expect(plan.contents).toContain('<string>serve</string>');
    expect(plan.load[0]).toEqual(['launchctl', 'bootstrap', 'gui/501', plan.path]);
    expect(plan.unload[0]).toEqual(['launchctl', 'bootout', `gui/501/${SERVICE_LABEL}`]);
  });

  test('리눅스는 systemd user unit 을 만들고 로그아웃을 넘긴다', () => {
    const plan = servicePlan({ platform: 'linux', home: '/home/x', command });
    expect(plan.kind).toBe('systemd');
    expect(plan.path).toBe('/home/x/.config/systemd/user/output-mesh.service');
    expect(plan.contents).toContain('Restart=always');
    expect(plan.contents).toContain('WantedBy=default.target');
    expect(plan.load).toContainEqual(['systemctl', '--user', 'enable', '--now', 'output-mesh.service']);
  });

  test('모르는 곳에는 반쯤 맞는 설정을 남기지 않는다', () => {
    expect(servicePlan({ platform: 'win32', home: 'C:/x', command })).toBeNull();
  });

  test('경로에 든 <>& 는 plist 를 깨지 않는다', () => {
    const odd = serviceCommand({ execPath: '/opt/b&b/bun', script: '/Users/x/a<b>/cli.mjs' });
    const plan = servicePlan({ platform: 'darwin', home: '/Users/x', uid: 501, command: odd });
    expect(plan.contents).toContain('<string>/opt/b&amp;b/bun</string>');
    expect(plan.contents).toContain('<string>/Users/x/a&lt;b&gt;/cli.mjs</string>');
  });

  test('포트 같은 인자를 서비스가 그대로 물려받는다', () => {
    const withPort = serviceCommand({ execPath: '/b/bun', script: '/s/cli.mjs', args: ['--port', '19900'] });
    expect(withPort).toEqual(['/b/bun', '/s/cli.mjs', 'serve', '--port', '19900']);
  });

  test('다음 부팅에 없을 경로는 서비스로 만들지 않는다 — bunx 는 캐시에 푼다', () => {
    expect(looksEphemeral('/Users/x/.bun/install/cache/output-mesh@0.3.0/bin/output-mesh.mjs')).toBe(true);
    expect(looksEphemeral('/private/var/folders/ab/T/x/bin/output-mesh.mjs')).toBe(true);
    expect(looksEphemeral('/Users/x/.bun/install/global/node_modules/output-mesh/bin/output-mesh.mjs')).toBe(false);
  });
});
