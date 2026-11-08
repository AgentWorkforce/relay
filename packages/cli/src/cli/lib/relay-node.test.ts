import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectCore,
  coreSocketPath,
  enableDelivery,
  relayNodeAssetName,
  relayNodeAssetUrl,
  readCoreState,
  readDeliveryRecord,
  readRelayNodeVersion,
  readTurnedOn,
  type CoreClient,
} from './relay-node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('relayNodeAssetName', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64', musl: false }, 'darwin-arm64'],
    [{ platform: 'darwin', arch: 'x64', musl: false }, 'darwin-x64'],
    [{ platform: 'linux', arch: 'x64', musl: false }, 'linux-x64'],
    [{ platform: 'linux', arch: 'arm64', musl: false }, 'linux-arm64'],
    [{ platform: 'win32', arch: 'x64', musl: false }, 'windows-x64.exe'],
  ] as const)('maps %o to %s', (target, suffix) => {
    expect(relayNodeAssetName('15.0.0', target)).toBe(`agent-relay-node-15.0.0-${suffix}`);
  });

  it.each([
    { platform: 'linux', arch: 'x64', musl: true },
    { platform: 'win32', arch: 'arm64', musl: false },
    { platform: 'freebsd', arch: 'x64', musl: false },
  ] as const)('publishes nothing for %o', (target) => {
    expect(relayNodeAssetName('15.0.0', target)).toBeUndefined();
  });

  it('downloads from the CLI v* release tags', () => {
    expect(relayNodeAssetUrl('15.0.0', 'agent-relay-node-15.0.0-linux-x64')).toBe(
      'https://github.com/AgentWorkforce/relay/releases/download/v15.0.0/agent-relay-node-15.0.0-linux-x64'
    );
  });

  it('names the assets the release workflow publishes', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/publish.yml'), 'utf8');
    for (const suffix of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64']) {
      expect(workflow).toContain(`suffix: ${suffix}`);
    }
    expect(workflow).toContain('agent-relay-node-${VERSION}-${SUFFIX}${EXT}');
    expect(workflow).not.toContain('relay-node-v');
    expect(fs.existsSync(path.join(repoRoot, '.github/workflows/relay-node-release.yml'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('connectCore adapter', () => {
  let dir: string;
  let server: net.Server | undefined;

  beforeEach(() => {
    // Short: a Unix socket path has a ~104-byte limit.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
    fs.chmodSync(dir, 0o700);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers undefined when no core listens', async () => {
    await expect(connectCore(path.join(dir, 'missing.sock'), 500)).resolves.toBeUndefined();
  });

  it('answers undefined when the socket file is left but nothing listens', async () => {
    const socket = path.join(dir, 'core.sock');
    server = net.createServer();
    await new Promise<void>((resolve) => server!.listen(socket, resolve));
    fs.chmodSync(socket, 0o600);
    // Closing the server unlinks the socket; keep a stale socket file instead.
    const stale = path.join(dir, 'stale.sock');
    fs.renameSync(socket, stale);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(connectCore(stale, 500)).resolves.toBeUndefined();
  });

  it('still throws, rather than answering undefined, for a socket it must not trust', async () => {
    const socket = path.join(dir, 'core.sock');
    fs.writeFileSync(socket, '', { mode: 0o600 });
    await expect(connectCore(socket, 500)).rejects.toThrow('only you can use');
  });

  it('resolves the default socket through the package', () => {
    expect(coreSocketPath({}, '/home/me')).toBe('/home/me/.agentworkforce/desktop/core.sock');
  });
});

describe.skipIf(process.platform === 'win32')('readRelayNodeVersion', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-version-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function script(output: string): string {
    const file = path.join(dir, `bin-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
    return file;
  }

  it("reads the core's own --version line, release or development", () => {
    expect(readRelayNodeVersion(script('agent-relay-node 15.0.0'))).toBe('15.0.0');
    expect(readRelayNodeVersion(script('agent-relay-node 15.0.1-dev+0123456789ab'))).toBe(
      '15.0.1-dev+0123456789ab'
    );
  });

  it('refuses another program that prints the version somewhere', () => {
    expect(readRelayNodeVersion(script('relaycast-engine 15.0.0'))).toBeUndefined();
    expect(readRelayNodeVersion(script('not agent-relay-node 15.0.0'))).toBeUndefined();
    expect(readRelayNodeVersion(script('agent-relay-node 15.0.0 (and more)'))).toBeUndefined();
    expect(readRelayNodeVersion(path.join(dir, 'missing'))).toBeUndefined();
  });
});

describe('enableDelivery', () => {
  function client(initial: Record<string, unknown>, refuse: string[] = []): CoreClient & { sets: unknown[] } {
    const values = { ...initial };
    const sets: unknown[] = [];
    return {
      sets,
      async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === 'settings.get') return { ...values } as T;
        sets.push(params);
        const [key] = Object.keys(params);
        if (refuse.includes(key)) throw new Error(`${key} is not available here.`);
        if (key === 'direct_delivery_default') values.direct_delivery ??= true;
        else values[key] = params[key];
        return { ...values } as T;
      },
      close: () => undefined,
    };
  }

  it('turns on only what is off, and reports what it turned on', async () => {
    const core = client({
      auto_activate: true,
      codex_stop_hook: false,
      opencode_plugin: true,
      opencode_auto_activate: true,
      pi_extension: false,
      pi_auto_activate: false,
    });
    const outcome = await enableDelivery(core, ['codex', 'opencode', 'pi']);
    expect(core.sets).toEqual([
      { codex_stop_hook: true },
      { pi_extension: true },
      { pi_auto_activate: true },
    ]);
    expect(outcome.turnedOn).toEqual(['codex_stop_hook', 'pi_extension', 'pi_auto_activate']);
    expect(outcome.results.map((r) => [r.id, r.status])).toEqual([
      ['codex', 'on'],
      ['opencode', 'on'],
      ['pi', 'on'],
    ]);
  });

  it('turns on Cursor through its hooks setting, and keeps the other tools when an older core refuses it', async () => {
    const on = await enableDelivery(client({ auto_activate: true }), ['cursor']);
    expect(on.results).toEqual([
      expect.objectContaining({ id: 'cursor', status: 'on', route: 'hooks in ~/.cursor/hooks.json' }),
    ]);
    expect(on.turnedOn).toEqual(['cursor_direct_delivery']);

    const refused = client({ auto_activate: true }, ['cursor_direct_delivery']);
    const outcome = await enableDelivery(refused, ['cursor', 'grok']);
    expect(outcome.results).toEqual([
      expect.objectContaining({ id: 'cursor', status: 'failed' }),
      expect.objectContaining({ id: 'grok', status: 'on' }),
    ]);
  });

  it('reports a refused setting as a failure for that tool only', async () => {
    const core = client({ auto_activate: true }, ['devin_direct_delivery']);
    const outcome = await enableDelivery(core, ['devin', 'grok']);
    expect(outcome.results).toEqual([
      expect.objectContaining({
        id: 'devin',
        status: 'failed',
        message: 'devin_direct_delivery is not available here.',
      }),
      expect.objectContaining({ id: 'grok', status: 'on' }),
    ]);
    expect(outcome.turnedOn).toEqual(['grok_leader']);
  });

  it('rolls back the settings of a tool whose delivery fails, so MCP is its only route', async () => {
    const core = client({ auto_activate: false }, ['claude_session_hook']);
    const outcome = await enableDelivery(core, ['claude']);
    expect(core.sets).toEqual([
      { direct_delivery_default: true },
      { claude_session_hook: true },
      { direct_delivery: false },
    ]);
    expect(outcome.results[0]).toMatchObject({ id: 'claude', status: 'failed' });
    // Nothing injected: automatic activation is never turned on.
    expect(outcome.turnedOn).toEqual([]);
    expect(outcome.turnedOff).toEqual(['direct_delivery']);
  });

  it('turns off what an earlier run turned on for a tool that now fails', async () => {
    const core = client({ auto_activate: true, direct_delivery: true, claude_session_hook: false }, [
      'claude_session_hook',
    ]);
    const outcome = await enableDelivery(core, ['claude'], ['auto_activate', 'direct_delivery']);
    expect(core.sets).toEqual([
      { claude_session_hook: true },
      { direct_delivery: false },
      { auto_activate: false },
    ]);
    expect(outcome.turnedOff).toEqual(['direct_delivery', 'auto_activate']);
  });

  it('keeps automatic activation for a tool an earlier run injected into', async () => {
    const core = client({ auto_activate: true, codex_stop_hook: true }, ['grok_leader']);
    const outcome = await enableDelivery(core, ['grok'], ['codex_stop_hook', 'auto_activate']);
    expect(core.sets).toEqual([{ grok_leader: true }]);
    expect(outcome.results[0]).toMatchObject({ id: 'grok', status: 'failed' });
    expect(outcome.turnedOff).toEqual([]);
  });

  it('never turns off a setting init did not turn on', async () => {
    const core = client({ auto_activate: true, direct_delivery: true }, ['claude_session_hook']);
    const outcome = await enableDelivery(core, ['claude']);
    expect(core.sets).toEqual([{ claude_session_hook: true }]);
    expect(outcome.turnedOff).toEqual([]);
  });

  it('sends every tool to MCP and rolls back when automatic activation fails', async () => {
    const core = client({ auto_activate: false }, ['auto_activate']);
    const outcome = await enableDelivery(core, ['codex', 'grok']);
    expect(core.sets).toEqual([
      { codex_stop_hook: true },
      { grok_leader: true },
      { auto_activate: true },
      { codex_stop_hook: false },
      { grok_leader: false },
    ]);
    expect(outcome.results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(outcome.results[0].message).toContain(
      'automatic activation: auto_activate is not available here.'
    );
    expect(outcome.turnedOn).toEqual([]);
  });

  it("leaves the person's crossSessionInbound alone and says messages are held", async () => {
    const core = client({ auto_activate: true, claude_session_hook: true, direct_delivery: false });
    const outcome = await enableDelivery(core, ['claude']);
    expect(outcome.results[0]).toMatchObject({ id: 'claude', status: 'held' });
    expect(outcome.turnedOn).toEqual([]);
  });
});

describe('records', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-records-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('never trusts a core record whose pid could signal a process group', () => {
    const file = path.join(dir, 'core.json');
    for (const pid of [0, 1, -5, 1.5, '12']) {
      fs.writeFileSync(file, JSON.stringify({ pid, socket: '/s', binary: '/b' }));
      expect(readCoreState(file)).toBeUndefined();
    }
    fs.writeFileSync(file, JSON.stringify({ pid: 4242, socket: '/s', binary: '/b' }));
    expect(readCoreState(file)).toEqual({ pid: 4242, socket: '/s', binary: '/b' });
  });

  it('reads only string keys from the settings record', () => {
    const file = path.join(dir, 'core-settings.json');
    fs.writeFileSync(file, JSON.stringify({ turnedOn: ['auto_activate', 3, null, 'codex_stop_hook'] }));
    expect(readTurnedOn(file)).toEqual(['auto_activate', 'codex_stop_hook']);
    expect(readTurnedOn(path.join(dir, 'missing.json'))).toEqual([]);
  });

  it('reads the recorded Claude settings files, strings only', () => {
    const file = path.join(dir, 'core-settings.json');
    // An older record listed the files that were unset.
    fs.writeFileSync(file, JSON.stringify({ turnedOn: ['direct_delivery'], claudeInbound: ['/a', 7] }));
    expect(readDeliveryRecord(file)).toEqual({
      turnedOn: ['direct_delivery'],
      claudeInbound: { '/a': null },
    });
    fs.writeFileSync(
      file,
      JSON.stringify({
        turnedOn: ['direct_delivery'],
        claudeInbound: { '/a': null, '/b': 'accept', '/c': 3 },
      })
    );
    expect(readDeliveryRecord(file).claudeInbound).toEqual({ '/a': null, '/b': 'accept' });
    fs.writeFileSync(file, 'null');
    expect(readDeliveryRecord(file)).toEqual({ turnedOn: [], claudeInbound: {} });
  });

  it('reads the recorded tool file states, dropping any of another shape', () => {
    const file = path.join(dir, 'core-settings.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        turnedOn: ['claude_session_hook', 'opencode_plugin'],
        claudeFiles: {
          '/h/.claude/settings.json': { existed: false, backup: false, dir: true },
          '/h/.claude-x/settings.json': { existed: 'no' },
        },
        openCode: {
          file: '/h/.config/opencode/plugins/agent-relay.js',
          plugin: false,
          off: false,
          dir: false,
        },
        pi: {
          file: '/h/.pi/agent/extensions/agent-relay.js',
          marker: '/h/.agentworkforce/desktop/pi-extension.off',
          extension: false,
          off: false,
          dir: true,
        },
      })
    );
    expect(readDeliveryRecord(file)).toEqual({
      turnedOn: ['claude_session_hook', 'opencode_plugin'],
      claudeInbound: {},
      claudeFiles: { '/h/.claude/settings.json': { existed: false, backup: false, dir: true } },
      openCode: { file: '/h/.config/opencode/plugins/agent-relay.js', plugin: false, off: false, dir: false },
      pi: {
        file: '/h/.pi/agent/extensions/agent-relay.js',
        marker: '/h/.agentworkforce/desktop/pi-extension.off',
        extension: false,
        off: false,
        dir: true,
      },
    });
    fs.writeFileSync(file, JSON.stringify({ turnedOn: [], openCode: { file: 'relative', plugin: false } }));
    expect(readDeliveryRecord(file)).toEqual({ turnedOn: [], claudeInbound: {} });
    fs.writeFileSync(
      file,
      JSON.stringify({
        turnedOn: [],
        pi: { file: '/h/x.js', marker: 'relative', extension: false, off: false, dir: false },
      })
    );
    expect(readDeliveryRecord(file)).toEqual({ turnedOn: [], claudeInbound: {} });
    fs.writeFileSync(
      file,
      JSON.stringify({
        turnedOn: [],
        pi: {
          file: '/h/.pi/agent/extensions/agent-relay.js',
          marker: '/h/important.txt',
          extension: false,
          off: false,
          dir: false,
        },
      })
    );
    expect(readDeliveryRecord(file)).toEqual({ turnedOn: [], claudeInbound: {} });
  });
});
