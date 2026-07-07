import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyBrokerStartError,
  classifyBrokerStartStage,
  describeError,
  readNodeDeliveryStatus,
  waitForNodeDelivery,
} from './broker-lifecycle.js';

describe('describeError', () => {
  it('returns plain message for a bare Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('unwraps the Node fetch failed cause and surfaces the network code', () => {
    // Mirror the shape Node 22 produces: TypeError with a cause carrying .code.
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3889'), {
      code: 'ECONNREFUSED',
    });
    const err = new TypeError('fetch failed', { cause });

    const result = describeError(err);
    expect(result).toContain('fetch failed');
    expect(result).toContain('ECONNREFUSED');
    expect(result).toContain('127.0.0.1');
  });

  it('unwraps DNS errors (ENOTFOUND)', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.agentrelay.com'), {
      code: 'ENOTFOUND',
    });
    const err = new TypeError('fetch failed', { cause });

    const result = describeError(err);
    expect(result).toContain('ENOTFOUND');
    expect(result).toContain('agentrelay.com');
  });

  it('handles non-Error values without throwing', () => {
    expect(describeError('something went wrong')).toBe('something went wrong');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(null)).toBe('null');
  });

  it('caps the cause-chain walk so a cycle cannot loop forever', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    // Just needs to terminate — the assertion is the absence of a hang.
    expect(typeof describeError(a)).toBe('string');
  });
});

describe('classifyBrokerStartError', () => {
  it('prefers the underlying network code over the constructor name', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = new TypeError('fetch failed', { cause });

    expect(classifyBrokerStartError(err)).toBe('ECONNREFUSED');
  });

  it('falls back to the constructor name when no code is present', () => {
    expect(classifyBrokerStartError(new Error('whatever'))).toBe('Error');
    expect(classifyBrokerStartError(new TypeError('boom'))).toBe('TypeError');
  });

  it('handles non-Error values', () => {
    expect(classifyBrokerStartError('oops')).toBe('string');
    expect(classifyBrokerStartError(undefined)).toBe('undefined');
  });
});

describe('classifyBrokerStartStage', () => {
  it('marks already-running brokers from the message text', () => {
    const message = 'another broker instance is already running in this directory (/tmp/x)';
    expect(classifyBrokerStartStage(new Error(message), message)).toBe('already_running');
  });

  it('classifies fetch failures as connect-stage errors', () => {
    const cause = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = new TypeError('fetch failed', { cause });
    expect(classifyBrokerStartStage(err, 'fetch failed')).toBe('connect');
  });

  it('classifies broker-exited-before-ready as a spawn failure', () => {
    const message = 'Broker process exited with code 1 before becoming ready (pid=123; …)';
    expect(classifyBrokerStartStage(new Error(message), message)).toBe('spawn');
  });

  it('falls back to startup for everything else', () => {
    expect(classifyBrokerStartStage(new Error('???'), '???')).toBe('startup');
  });
});

describe('readNodeDeliveryStatus', () => {
  it('reads the canonical snake_case broker status shape', () => {
    expect(
      readNodeDeliveryStatus({
        node_connected: true,
        node_delivery: { token_present: true, connected: true },
      })
    ).toEqual({ tokenPresent: true, connected: true });
  });

  it('defaults absent node delivery fields to false', () => {
    expect(readNodeDeliveryStatus({ agent_count: 0 })).toEqual({
      tokenPresent: false,
      connected: false,
    });
  });

  it('rejects non-object status values', () => {
    expect(readNodeDeliveryStatus(null)).toBeNull();
    expect(readNodeDeliveryStatus('nope')).toBeNull();
  });
});

describe('waitForNodeDelivery', () => {
  it('continues polling after a transient status failure', async () => {
    let now = 0;
    let calls = 0;
    const relay = {
      async getStatus() {
        calls += 1;
        if (calls === 1) {
          throw new Error('broker not ready yet');
        }
        return {
          node_connected: calls >= 3,
          node_delivery: { token_present: true, connected: calls >= 3 },
        };
      },
    };
    const deps = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };

    await expect(waitForNodeDelivery(relay as never, deps as never, 1_000)).resolves.toEqual({
      ready: true,
      status: {
        node_connected: true,
        node_delivery: { token_present: true, connected: true },
      },
    });
    expect(calls).toBe(3);
  });
});

// ── runUpCommand node-config gating ──────────────────────────────────────────
// These use a real temp project dir (config discovery/loading touch the real
// fs) with everything broker-shaped mocked out through CoreDependencies.

vi.mock('../telemetry/index.js', () => ({ track: vi.fn() }));
vi.mock('@agent-relay/fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/fleet')>();
  return {
    ...actual,
    startServeNode: vi.fn(() => ({ stop: vi.fn(async () => undefined), done: Promise.resolve() })),
  };
});

import fsReal from 'node:fs';
import os from 'node:os';
import pathReal from 'node:path';
import { startServeNode } from '@agent-relay/fleet';
import { runUpCommand } from './broker-lifecycle.js';
import type { CoreDependencies } from '../commands/core.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const upTmpRoots: string[] = [];

function createUpHarness() {
  const projectRoot = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), 'broker-lifecycle-up-'));
  upTmpRoots.push(projectRoot);
  const dataDir = pathReal.join(projectRoot, '.agentworkforce', 'relay');
  fsReal.mkdirSync(dataDir, { recursive: true });

  const connection = JSON.stringify({
    url: 'http://127.0.0.1:4999',
    port: 4999,
    api_key: 'test',
    pid: 999999,
  });
  const createRelay = vi.fn(async () => ({
    spawn: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({})),
    shutdown: vi.fn(async () => undefined),
    workspaceKey: 'rk_test',
  }));
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  });
  const log = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();

  const deps = {
    getProjectPaths: () => ({ projectRoot, dataDir, teamDir: projectRoot }),
    loadTeamsConfig: () => null,
    createRelay,
    spawnProcess: vi.fn(),
    execCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
    killProcess: vi.fn(() => {
      throw new Error('not running');
    }),
    fs: {
      existsSync: fsReal.existsSync,
      // The connection file is "written by the broker" — our mock relay writes
      // nothing, so serve it from memory for any connection.json read.
      readFileSync: (file: string, encoding: BufferEncoding) =>
        file.endsWith('connection.json') ? connection : fsReal.readFileSync(file, encoding),
      writeFileSync: fsReal.writeFileSync,
      unlinkSync: fsReal.unlinkSync,
      readdirSync: fsReal.readdirSync,
      mkdirSync: fsReal.mkdirSync,
      rmSync: fsReal.rmSync,
      accessSync: fsReal.accessSync,
    },
    generateAgentName: () => 'agent',
    checkForUpdates: vi.fn(async () => ({ updateAvailable: false })),
    getVersion: () => 'test',
    env: {} as NodeJS.ProcessEnv,
    argv: ['node', 'agent-relay', 'node', 'up'],
    execPath: process.execPath,
    cliScript: 'cli.js',
    pid: process.pid,
    isPortInUse: vi.fn(async () => false),
    now: () => 0,
    sleep: async () => undefined,
    onSignal: vi.fn(),
    holdOpen: async () => undefined,
    log,
    warn,
    error,
    exit,
  } as unknown as CoreDependencies;

  return { deps, projectRoot, createRelay, log, warn, error, exit };
}

afterEach(() => {
  vi.mocked(startServeNode).mockClear();
  for (const dir of upTmpRoots.splice(0)) {
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runUpCommand node-config gating', () => {
  it('fails fast on a missing explicit --config BEFORE the broker starts', async () => {
    const { deps, createRelay, error } = createUpHarness();

    await expect(
      runUpCommand({ config: './does-not-exist.ts', discoverConfig: true }, deps)
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(error.mock.calls.flat().join('\n')).toContain('Node config file not found');
    expect(createRelay).not.toHaveBeenCalled();
    expect(startServeNode).not.toHaveBeenCalled();
  });

  it('warns and serves the implicit node when a DISCOVERED config fails to load', async () => {
    const { deps, projectRoot, createRelay, warn } = createUpHarness();
    fsReal.writeFileSync(pathReal.join(projectRoot, 'agent-relay.js'), 'export default 42;\n');

    await runUpCommand({ discoverConfig: true }, deps);

    expect(warn.mock.calls.flat().join('\n')).toContain('Ignoring discovered node config');
    expect(createRelay).toHaveBeenCalledTimes(1);
    expect(startServeNode).toHaveBeenCalledTimes(1);
    const served = vi.mocked(startServeNode).mock.calls[0]![0];
    expect(served.definition.name).toBe(pathReal.basename(projectRoot));
  });

  it('never touches agent-relay.* files without the discoverConfig opt-in (legacy local up)', async () => {
    const { deps, projectRoot, createRelay, warn } = createUpHarness();
    // A module with a top-level throw: if the legacy path ever imported it,
    // the discovered-load warning (or a startup failure) would appear.
    fsReal.writeFileSync(pathReal.join(projectRoot, 'agent-relay.js'), 'throw new Error("BOOM");\n');

    await runUpCommand({}, deps);

    expect(warn.mock.calls.flat().join('\n')).not.toContain('Ignoring discovered node config');
    expect(createRelay).toHaveBeenCalledTimes(1);
    expect(startServeNode).toHaveBeenCalledTimes(1);
  });

  it('skips config discovery entirely when the implicit fleet node is disabled', async () => {
    const { deps, projectRoot, warn } = createUpHarness();
    (deps.env as NodeJS.ProcessEnv).AGENT_RELAY_DISABLE_IMPLICIT_FLEET_NODE = '1';
    fsReal.writeFileSync(pathReal.join(projectRoot, 'agent-relay.js'), 'throw new Error("BOOM");\n');

    await runUpCommand({ discoverConfig: true }, deps);

    expect(warn.mock.calls.flat().join('\n')).not.toContain('Ignoring discovered node config');
    expect(startServeNode).not.toHaveBeenCalled();
  });

  it('serves a valid discovered config in place of the implicit node and honors nodeName', async () => {
    const { deps, projectRoot } = createUpHarness();
    fsReal.writeFileSync(
      pathReal.join(projectRoot, 'agent-relay.mjs'),
      // Self-contained defineNode-shaped module: a bare `@agent-relay/fleet`
      // import would not resolve from the temp dir, and the loader validates
      // via the __agentRelayFleetNode marker.
      "export default { __agentRelayFleetNode: true, name: 'from-config', capabilities: {}, triggers: [] };\n"
    );

    await runUpCommand({ discoverConfig: true, nodeName: 'enrolled-name' }, deps);

    const served = vi.mocked(startServeNode).mock.calls[0]![0];
    expect(served.definition.name).toBe('from-config');
    expect(served.nameOverride).toBe('enrolled-name');
  });
});
