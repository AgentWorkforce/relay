import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BRIDGE_VERSION,
  connectCore,
  coreSocketPath,
  enableDelivery,
  pipeName,
  probeAssetName,
  probeAssetUrl,
  readCoreState,
  readTurnedOn,
  type CoreClient,
} from './probe-core.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('probeAssetName', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64', musl: false }, 'darwin-arm64'],
    [{ platform: 'darwin', arch: 'x64', musl: false }, 'darwin-x64'],
    [{ platform: 'linux', arch: 'x64', musl: false }, 'linux-x64'],
    [{ platform: 'linux', arch: 'arm64', musl: false }, 'linux-arm64'],
    [{ platform: 'win32', arch: 'x64', musl: false }, 'windows-x64.exe'],
  ] as const)('maps %o to %s', (target, suffix) => {
    expect(probeAssetName('15.0.0', target)).toBe(`agent-relay-probe-15.0.0-${suffix}`);
  });

  it.each([
    { platform: 'linux', arch: 'x64', musl: true },
    { platform: 'win32', arch: 'arm64', musl: false },
    { platform: 'freebsd', arch: 'x64', musl: false },
  ] as const)('publishes nothing for %o', (target) => {
    expect(probeAssetName('15.0.0', target)).toBeUndefined();
  });

  it('downloads from probe-v tags, apart from the CLI v* tags', () => {
    expect(probeAssetUrl('15.0.0', 'agent-relay-probe-15.0.0-linux-x64')).toBe(
      'https://github.com/AgentWorkforce/relay/releases/download/probe-v15.0.0/agent-relay-probe-15.0.0-linux-x64'
    );
  });

  it('names the assets the release workflow publishes', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/probe-release.yml'), 'utf8');
    for (const suffix of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64']) {
      expect(workflow).toContain(`suffix: ${suffix}`);
    }
    expect(workflow).toContain('agent-relay-probe-${VERSION}-${SUFFIX}${EXT}');
    expect(workflow).toContain('probe-v${VERSION}');
  });
});

describe('core socket', () => {
  it('defaults to the desktop socket under home, as the core does', () => {
    expect(coreSocketPath({}, '/home/me')).toBe('/home/me/.agentworkforce/desktop/core.sock');
  });

  it('honours AGENT_RELAY_CORE_SOCKET, a relative one beside the default', () => {
    expect(coreSocketPath({ AGENT_RELAY_CORE_SOCKET: '/run/x.sock' }, '/home/me')).toBe('/run/x.sock');
    expect(coreSocketPath({ AGENT_RELAY_CORE_SOCKET: 'core.dev.sock' }, '/home/me')).toBe(
      '/home/me/.agentworkforce/desktop/core.dev.sock'
    );
    expect(coreSocketPath({ AGENT_RELAY_CORE_SOCKET: '  ' }, '/home/me')).toBe(
      '/home/me/.agentworkforce/desktop/core.sock'
    );
  });

  it('derives the Windows pipe exactly as the core does (relay::transport tests share the vector)', () => {
    const expected = '\\\\.\\pipe\\agent-relay-367ccf5106272db6';
    expect(pipeName('C:\\Users\\A\\.agentworkforce\\desktop\\core.sock')).toBe(expected);
    expect(pipeName('c:/users/a/.agentworkforce/desktop/core.sock')).toBe(expected);
    expect(pipeName('\\\\?\\C:\\Users\\A\\.agentworkforce\\desktop\\core.sock')).toBe(expected);
  });

  it('speaks the bridge version the core declares', () => {
    const protocol = fs.readFileSync(path.join(repoRoot, 'crates/probe/src/relay/protocol.rs'), 'utf8');
    expect(protocol).toContain(`pub const BRIDGE_VERSION: u32 = ${BRIDGE_VERSION};`);
  });
});

describe.skipIf(process.platform === 'win32')('connectCore', () => {
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

  /** A tiny NDJSON core: answers hello and status.get, sends an event in between, refuses the rest. */
  async function serve(socket: string, seen: string[]): Promise<void> {
    server = net.createServer((connection) => {
      let buffer = '';
      connection.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as {
            id: number;
            method: string;
            params: unknown;
          };
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          seen.push(`${request.method} ${JSON.stringify(request.params)}`);
          connection.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { revision: 3 } })}\n`
          );
          const reply =
            request.method === 'hello'
              ? { result: { bridge_version: BRIDGE_VERSION } }
              : request.method === 'status.get'
                ? { result: { daemon: { pid: 42, version: '15.0.0', socket } } }
                : { error: { code: -32601, message: 'Unknown method.' } };
          connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(socket, resolve));
  }

  it('greets the core, skips events, and returns results and errors by id', async () => {
    const socket = path.join(dir, 'core.sock');
    const seen: string[] = [];
    await serve(socket, seen);
    const client = (await connectCore(socket, 2_000))!;
    expect(client).toBeDefined();
    await expect(client.call('status.get')).resolves.toMatchObject({ daemon: { pid: 42 } });
    await expect(client.call('nope')).rejects.toThrow('Unknown method.');
    client.close();
    expect(seen[0]).toBe(`hello {"bridge_version":${BRIDGE_VERSION}}`);
  });

  it('answers undefined when no core listens', async () => {
    await expect(connectCore(path.join(dir, 'missing.sock'), 500)).resolves.toBeUndefined();
  });

  it('refuses a socket in a directory others can write to', async () => {
    const socket = path.join(dir, 'core.sock');
    await serve(socket, []);
    fs.chmodSync(dir, 0o777);
    await expect(connectCore(socket, 500)).rejects.toThrow('only you can write to');
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
    const core = client({ auto_activate: true, codex_stop_hook: false, opencode_plugin: true });
    const outcome = await enableDelivery(core, ['codex', 'opencode', 'pi']);
    expect(core.sets).toEqual([{ codex_stop_hook: true }]);
    expect(outcome.turnedOn).toEqual(['codex_stop_hook']);
    expect(outcome.results.map((r) => [r.id, r.status])).toEqual([
      ['codex', 'on'],
      ['opencode', 'on'],
      ['pi', 'on'],
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-records-'));
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
});
