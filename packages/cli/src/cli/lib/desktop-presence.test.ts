import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopAppInstalled, foreignCoreRunning, startDesktopCore } from './desktop-presence.js';
import type { CoreClient } from './probe-core.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-desktop-presence-'));
  vi.stubEnv('AGENT_RELAY_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function clientOf(pid: number): CoreClient {
  return {
    call: vi.fn(async () => ({ daemon: { pid, version: '15.0.6', socket: '/core.sock' } })),
    close: vi.fn(),
  } as unknown as CoreClient;
}

describe('desktopAppInstalled', () => {
  // Only the temporary home counts, whatever this machine has installed.
  const inHome = (file: string) => file.startsWith(home) && fs.existsSync(file);

  it('finds an app in the home Applications folder on macOS', () => {
    fs.mkdirSync(path.join(home, 'Applications', 'Agent Relay.app'), { recursive: true });
    expect(desktopAppInstalled('darwin', home, {}, inHome)).toBe(true);
  });

  it('finds the headless service on Linux', () => {
    const unit = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(path.join(unit, 'agent-relay.service'), '');
    expect(desktopAppInstalled('linux', home, {}, inHome)).toBe(true);
  });

  it('finds a stopped per-user Linux install by its binaries, not a leftover folder', () => {
    const root = path.join(home, '.local', 'lib', 'agent-relay');
    fs.mkdirSync(path.join(root, 'current'), { recursive: true });
    fs.mkdirSync(path.join(root, '2026.10.66', 'tree', 'usr', 'bin'), { recursive: true });
    expect(desktopAppInstalled('linux', home, {}, inHome)).toBe(false);

    const app = path.join(root, '2026.10.66', 'tree', 'usr', 'bin', 'agent-relay-desktop');
    fs.writeFileSync(app, '');
    expect(desktopAppInstalled('linux', home, {}, inHome)).toBe(true);

    fs.rmSync(app);
    fs.writeFileSync(path.join(root, 'current', 'agent-relay-probe'), '');
    expect(desktopAppInstalled('linux', home, {}, inHome)).toBe(true);
  });

  it('honours the install prefix and config folder the Linux installer does', () => {
    const prefix = path.join(home, 'custom-prefix');
    fs.mkdirSync(path.join(prefix, 'current'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'current', 'agent-relay-probe'), '');
    expect(desktopAppInstalled('linux', home, { AGENT_RELAY_PREFIX: prefix }, inHome)).toBe(true);

    const config = path.join(home, 'custom-config');
    fs.mkdirSync(path.join(config, 'systemd', 'user'), { recursive: true });
    fs.writeFileSync(path.join(config, 'systemd', 'user', 'agent-relay.service'), '');
    expect(desktopAppInstalled('linux', home, { XDG_CONFIG_HOME: config }, inHome)).toBe(true);
  });

  it('finds the per-user install on Windows', () => {
    fs.mkdirSync(path.join(home, 'Programs', 'AgentRelay'), { recursive: true });
    expect(desktopAppInstalled('win32', home, { LOCALAPPDATA: home }, inHome)).toBe(true);
  });

  it('does not take the data directory a core creates for the app', () => {
    fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'com.agentrelay.desktop'), {
      recursive: true,
    });
    expect(desktopAppInstalled('win32', home, {}, inHome)).toBe(false);
    expect(desktopAppInstalled('freebsd', home, {}, inHome)).toBe(false);
  });
});

describe('foreignCoreRunning', () => {
  it('is false with no core, and for the core init recorded', async () => {
    expect(await foreignCoreRunning(async () => undefined)).toBe(false);
    fs.mkdirSync(path.join(home, 'local'));
    fs.writeFileSync(
      path.join(home, 'local', 'core.json'),
      JSON.stringify({ pid: 42, socket: '/core.sock', binary: '/core', version: '15.0.6' })
    );
    expect(await foreignCoreRunning(async () => clientOf(42))).toBe(false);
  });

  it('is true for another pid and for a core that cannot be read', async () => {
    expect(await foreignCoreRunning(async () => clientOf(7))).toBe(true);
    expect(
      await foreignCoreRunning(async () => {
        throw new Error('unreadable');
      })
    ).toBe(true);
  });
});

describe('startDesktopCore', () => {
  /** Records every command instead of running it: nothing here reaches the real app or systemd. */
  function effects(statuses: Record<string, number | null> = {}, files: string[] = []) {
    const ran: string[] = [];
    const launched: string[] = [];
    return {
      ran,
      launched,
      effects: {
        run: (command: string, args: string[]) => {
          const line = [command, ...args].join(' ');
          ran.push(line);
          return line in statuses ? statuses[line] : 0;
        },
        launch: (command: string, args: string[]) => {
          launched.push([command, ...args].join(' '));
        },
        executable: (file: string) => files.includes(file),
      },
    };
  }
  const IS_ENABLED = 'systemctl --user is-enabled --quiet agent-relay.service';

  it('opens the macOS app in the background, hidden', () => {
    const fake = effects();
    expect(startDesktopCore('darwin', home, {}, fake.effects)).toBe('open -g -j -b com.agentrelay.desktop');
    expect(fake.ran).toEqual(['open -g -j -b com.agentrelay.desktop']);
  });

  it('throws when macOS cannot open the app, as after an uninstall', () => {
    const fake = effects({ 'open -g -j -b com.agentrelay.desktop': 1 });
    expect(() => startDesktopCore('darwin', home, {}, fake.effects)).toThrow('exited with 1');
  });

  it('starts the enabled Linux user unit', () => {
    const fake = effects();
    expect(startDesktopCore('linux', home, {}, fake.effects)).toBe(
      'systemctl --user start agent-relay.service'
    );
    expect(fake.ran).toEqual([IS_ENABLED, 'systemctl --user start agent-relay.service']);
    expect(fake.launched).toEqual([]);
  });

  it('runs the Linux launcher in the tray when the unit is not enabled and there is a display', () => {
    const launcher = '/usr/bin/agent-relay-desktop';
    const tray = effects({ [IS_ENABLED]: 1 }, [launcher]);
    expect(startDesktopCore('linux', home, { DISPLAY: ':0' }, tray.effects)).toBe(`${launcher} --background`);
    expect(tray.launched).toEqual([`${launcher} --background`]);
    expect(tray.ran).not.toContain('systemctl --user start agent-relay.service');

    const wayland = effects({ [IS_ENABLED]: null }, [launcher]);
    expect(startDesktopCore('linux', home, { WAYLAND_DISPLAY: 'wayland-0' }, wayland.effects)).toBe(
      `${launcher} --background`
    );
  });

  it('never starts the Linux launcher headless: no enabled unit and no display throws, launching nothing', () => {
    const launcher = '/usr/bin/agent-relay-desktop';
    const ssh = effects({ [IS_ENABLED]: 1 }, [launcher]);
    expect(() => startDesktopCore('linux', home, {}, ssh.effects)).toThrow(
      "the desktop app's core needs agent-relay.service enabled, or a desktop session (DISPLAY or WAYLAND_DISPLAY)"
    );
    expect(ssh.launched).toEqual([]);
    expect(ssh.ran).toEqual([IS_ENABLED]);
  });

  it('prefers the newest per-user Linux tree when there is no package launcher', () => {
    const root = path.join(home, '.local', 'lib', 'agent-relay');
    const tree = (version: string) => path.join(root, version, 'tree', 'usr', 'bin', 'agent-relay-desktop');
    for (const version of ['2026.9.70', '2026.10.66']) {
      fs.mkdirSync(path.dirname(tree(version)), { recursive: true });
      fs.writeFileSync(tree(version), '');
    }
    const fake = effects({ [IS_ENABLED]: 1 }, [tree('2026.9.70'), tree('2026.10.66')]);
    expect(startDesktopCore('linux', home, { DISPLAY: ':0' }, fake.effects)).toBe(
      `${tree('2026.10.66')} --background`
    );
  });

  it('throws on Linux when neither the unit nor a launcher is there', () => {
    const fake = effects({ [IS_ENABLED]: 1 });
    expect(() => startDesktopCore('linux', home, { DISPLAY: ':0' }, fake.effects)).toThrow(
      'no runnable agent-relay-desktop was found'
    );
    expect(fake.launched).toEqual([]);
  });

  it('has no start on Windows, and runs nothing', () => {
    const fake = effects();
    expect(startDesktopCore('win32', home, {}, fake.effects)).toBeUndefined();
    expect(fake.ran).toEqual([]);
  });
});
