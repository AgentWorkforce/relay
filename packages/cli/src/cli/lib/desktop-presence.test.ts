import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopAppInstalled, foreignCoreRunning } from './desktop-presence.js';
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
  it('finds an app in the home Applications folder on macOS', () => {
    fs.mkdirSync(path.join(home, 'Applications', 'Agent Relay.app'), { recursive: true });
    expect(desktopAppInstalled('darwin', home, {})).toBe(true);
  });

  it('finds the headless service on Linux', () => {
    const unit = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unit, { recursive: true });
    fs.writeFileSync(path.join(unit, 'agent-relay.service'), '');
    expect(desktopAppInstalled('linux', home, {})).toBe(true);
  });

  it('finds the per-user install on Windows', () => {
    fs.mkdirSync(path.join(home, 'Programs', 'AgentRelay'), { recursive: true });
    expect(desktopAppInstalled('win32', home, { LOCALAPPDATA: home })).toBe(true);
  });

  it('does not take the data directory a core creates for the app', () => {
    fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'com.agentrelay.desktop'), {
      recursive: true,
    });
    expect(desktopAppInstalled('win32', home, {})).toBe(false);
    expect(desktopAppInstalled('freebsd', home, {})).toBe(false);
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
