import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyBrokerStartError,
  classifyBrokerStartStage,
  describeErrorWithCause,
  getBrokerStatusWithRetry,
  isBundledBunExecutableEntrypoint,
  readNodeDeliveryStatus,
  resolveNodeIdentityFromSession,
  waitForNodeDelivery,
} from './broker-lifecycle.js';
import type { CoreDependencies, CoreRelay } from '../commands/core.js';

describe('isBundledBunExecutableEntrypoint', () => {
  it.each(['/$bunfs/root/agent-relay', 'B:/~BUN/root/agent-relay.exe', 'B:\\~BUN\\root\\agent-relay.exe'])(
    'recognizes the compiled Bun virtual entrypoint %s',
    (cliScript) => {
      expect(
        isBundledBunExecutableEntrypoint({ argv: ['bun', cliScript], cliScript } as CoreDependencies)
      ).toBe(true);
    }
  );

  it('does not classify the npm CLI running under plain Bun as compiled', () => {
    expect(
      isBundledBunExecutableEntrypoint({
        argv: ['bun', '/project/cli.js'],
        cliScript: '/project/cli.js',
      } as CoreDependencies)
    ).toBe(false);
  });
});

describe('describeErrorWithCause', () => {
  it('returns plain message for a bare Error', () => {
    expect(describeErrorWithCause(new Error('boom'))).toBe('boom');
  });

  it('unwraps the Node fetch failed cause and surfaces the network code', () => {
    // Mirror the shape Node 22 produces: TypeError with a cause carrying .code.
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3889'), {
      code: 'ECONNREFUSED',
    });
    const err = new TypeError('fetch failed', { cause });

    const result = describeErrorWithCause(err);
    expect(result).toContain('fetch failed');
    expect(result).toContain('ECONNREFUSED');
    expect(result).toContain('127.0.0.1');
  });

  it('unwraps DNS errors (ENOTFOUND)', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.agentrelay.com'), {
      code: 'ENOTFOUND',
    });
    const err = new TypeError('fetch failed', { cause });

    const result = describeErrorWithCause(err);
    expect(result).toContain('ENOTFOUND');
    expect(result).toContain('agentrelay.com');
  });

  it('redacts credentials found only in a nested cause', () => {
    const err = new Error('broker start failed', {
      cause: new Error('workspace rk_live_0123456789abcdef was rejected'),
    });

    expect(describeErrorWithCause(err)).toBe('broker start failed — workspace rk_live_…cdef was rejected');
  });

  it('handles non-Error values without throwing', () => {
    expect(describeErrorWithCause('something went wrong')).toBe('something went wrong');
    expect(describeErrorWithCause(undefined)).toBe('undefined');
    expect(describeErrorWithCause(null)).toBe('null');
  });

  it('caps the cause-chain walk so a cycle cannot loop forever', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    // Just needs to terminate — the assertion is the absence of a hang.
    expect(typeof describeErrorWithCause(a)).toBe('string');
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

describe('getBrokerStatusWithRetry', () => {
  function createDeps(sleep = vi.fn(async () => undefined)): CoreDependencies {
    return { log: vi.fn(), sleep } as unknown as CoreDependencies;
  }

  it('returns the status on the first successful attempt without sleeping', async () => {
    const candidate: Pick<CoreRelay, 'getStatus'> = {
      getStatus: vi.fn(async () => ({ agent_count: 0, pending_delivery_count: 0 })),
    };
    const deps = createDeps();

    const result = await getBrokerStatusWithRetry(candidate, deps);

    expect(result).toEqual({ agent_count: 0, pending_delivery_count: 0 });
    expect(candidate.getStatus).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('retries a transient connect failure and returns the status once the broker responds', async () => {
    let attempt = 0;
    const candidate: Pick<CoreRelay, 'getStatus'> = {
      getStatus: vi.fn(async () => {
        attempt += 1;
        if (attempt < 3) {
          throw new TypeError('Unable to connect. Is the computer able to access the url?');
        }
        return { agent_count: 0, pending_delivery_count: 0 };
      }),
    };
    const deps = createDeps();

    const result = await getBrokerStatusWithRetry(candidate, deps, true);

    expect(result).toEqual({ agent_count: 0, pending_delivery_count: 0 });
    expect(candidate.getStatus).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('Broker status check failed (attempt 1/4), retrying in 300ms...')
    );
  });

  it('exhausts its retry budget and throws the last error when the broker never responds', async () => {
    const err = new TypeError('Unable to connect. Is the computer able to access the url?');
    const candidate: Pick<CoreRelay, 'getStatus'> = {
      getStatus: vi.fn(async () => {
        throw err;
      }),
    };
    const deps = createDeps();

    await expect(getBrokerStatusWithRetry(candidate, deps)).rejects.toBe(err);
    // 4 total attempts: the initial try plus 3 retries.
    expect(candidate.getStatus).toHaveBeenCalledTimes(4);
    expect(deps.sleep).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-connect failure -- fails after a single attempt', async () => {
    const err = new Error('unauthorized');
    const candidate: Pick<CoreRelay, 'getStatus'> = {
      getStatus: vi.fn(async () => {
        throw err;
      }),
    };
    const deps = createDeps();

    await expect(getBrokerStatusWithRetry(candidate, deps)).rejects.toBe(err);
    expect(candidate.getStatus).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
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
vi.mock('./reflex-capture.js', () => ({
  startReflexCapture: vi.fn(() => ({ stop: vi.fn(async () => undefined) })),
}));
vi.mock('@agent-relay/fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/fleet')>();
  return {
    ...actual,
    startServeNode: vi.fn(() => ({ stop: vi.fn(async () => undefined), done: Promise.resolve() })),
  };
});
// The capability providers read the broker's resolved node id from its HTTP
// session; serve it from a fake so `node up` can attach providers to the node.
vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: class {
    async getSession() {
      return {
        node_id: 'node_a',
        node_name: 'the-node',
        // Live-shaped secrets so the verbose-output test can assert they never
        // leak into logs.
        workspace_key: 'rk_live_secret',
        node_token: 'nt_live_secret',
        broker_version: 'test',
        protocol_version: 2,
        mode: 'persist',
        uptime_secs: 1,
      };
    }
    async getStatus() {
      return {};
    }
    disconnect() {}
  },
}));

import fsReal from 'node:fs';
import os from 'node:os';
import pathReal from 'node:path';
import { startServeNode } from '@agent-relay/fleet';
import { setWorkspaceKey } from '@agent-relay/cloud';
import { runUpCommand } from './broker-lifecycle.js';
import { startReflexCapture } from './reflex-capture.js';
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
    workspaceId: 'rw_test',
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
      renameSync: fsReal.renameSync,
      unlinkSync: fsReal.unlinkSync,
      readdirSync: fsReal.readdirSync,
      mkdirSync: fsReal.mkdirSync,
      rmSync: fsReal.rmSync,
      accessSync: fsReal.accessSync,
    },
    generateAgentName: () => 'agent',
    checkForUpdates: vi.fn(async () => ({ updateAvailable: false })),
    getVersion: () => 'test',
    env: { RELAY_NODE_TOKEN: 'nt_live_test', RELAY_BASE_URL: 'https://engine.test' } as NodeJS.ProcessEnv,
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

  // Every start now consults the machine-global workspace store, so point it at
  // a scratch home instead of the developer's real one.
  const home = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), 'broker-lifecycle-home-'));
  upTmpRoots.push(home);
  (deps.env as NodeJS.ProcessEnv).AGENT_RELAY_HOME = home;

  return { deps, projectRoot, dataDir, home, createRelay, log, warn, error, exit };
}

/** Pin a workspace to the harness project, as a previous `up` would have. */
function writeRepositoryPin(dataDir: string, session: Record<string, string>): void {
  fsReal.mkdirSync(dataDir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(dataDir, 'workspace-key.json'), JSON.stringify(session, null, 2));
}

afterEach(() => {
  vi.mocked(startServeNode).mockClear();
  vi.mocked(startReflexCapture).mockClear();
  for (const dir of upTmpRoots.splice(0)) {
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runUpCommand node-config gating', () => {
  it('keeps Reflex diagnostics out of normal broker output', async () => {
    const { deps, log } = createUpHarness();

    await runUpCommand({}, deps);

    const reflexOptions = vi.mocked(startReflexCapture).mock.calls[0]?.[0];
    reflexOptions?.log?.('[reflex] cloud sync failed: database is locked');

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('[reflex]'));
  });

  it('shows Reflex diagnostics when --verbose is requested', async () => {
    const { deps, log } = createUpHarness();

    await runUpCommand({ verbose: true }, deps);

    const reflexOptions = vi.mocked(startReflexCapture).mock.calls[0]?.[0];
    reflexOptions?.log?.('[reflex] cloud sync failed: database is locked');

    expect(log).toHaveBeenCalledWith('[verbose] [reflex] cloud sync failed: database is locked');
  });

  it('writes Reflex diagnostics to the configured structured log file', async () => {
    const { deps, projectRoot, log } = createUpHarness();
    const logFile = pathReal.join(projectRoot, 'relay.log');
    const previousLogFile = process.env.AGENT_RELAY_LOG_FILE;
    process.env.AGENT_RELAY_LOG_FILE = logFile;

    try {
      await runUpCommand({ logFile }, deps);

      const reflexOptions = vi.mocked(startReflexCapture).mock.calls[0]?.[0];
      reflexOptions?.log?.('[reflex] cloud sync failed: database is locked');
      reflexOptions?.log?.('[reflex] history sync tick');

      const structuredLog = fsReal.readFileSync(logFile, 'utf-8');
      expect(structuredLog).toContain('[WARN] [reflex] cloud sync failed: database is locked');
      expect(structuredLog).toContain('[INFO] [reflex] history sync tick');
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('[reflex]'));
    } finally {
      if (previousLogFile === undefined) {
        delete process.env.AGENT_RELAY_LOG_FILE;
      } else {
        process.env.AGENT_RELAY_LOG_FILE = previousLogFile;
      }
    }
  });

  it('fails fast on a missing explicit --config BEFORE the broker starts', async () => {
    const { deps, createRelay, error } = createUpHarness();

    await expect(
      runUpCommand({ config: './does-not-exist.ts', discoverConfig: true }, deps)
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(error.mock.calls.flat().join('\n')).toContain('Node config file not found');
    expect(createRelay).not.toHaveBeenCalled();
    expect(startServeNode).not.toHaveBeenCalled();
  });

  it('serves no provider when a DISCOVERED config fails to load (broker capacity handles it)', async () => {
    const { deps, projectRoot, createRelay, warn } = createUpHarness();
    fsReal.writeFileSync(pathReal.join(projectRoot, 'agent-relay.js'), 'export default 42;\n');

    await runUpCommand({ discoverConfig: true }, deps);

    expect(warn.mock.calls.flat().join('\n')).toContain('Ignoring discovered node config');
    expect(createRelay).toHaveBeenCalledTimes(1);
    // No implicit provider is served; the broker's own capacity brings the node
    // online, so there is nothing to serve when the discovered config is invalid.
    expect(startServeNode).not.toHaveBeenCalled();
  });

  it('never touches agent-relay.* files without the discoverConfig opt-in (legacy local up)', async () => {
    const { deps, projectRoot, createRelay, warn } = createUpHarness();
    // A module with a top-level throw: if the legacy path ever imported it,
    // the discovered-load warning (or a startup failure) would appear.
    fsReal.writeFileSync(pathReal.join(projectRoot, 'agent-relay.js'), 'throw new Error("BOOM");\n');

    await runUpCommand({}, deps);

    expect(warn.mock.calls.flat().join('\n')).not.toContain('Ignoring discovered node config');
    expect(createRelay).toHaveBeenCalledTimes(1);
    expect(startServeNode).not.toHaveBeenCalled();
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
    expect(served.connection).toMatchObject({ nodeToken: 'nt_live_test', nodeId: 'node_a' });
    expect(served.providerName).toBe('from-config');
  });

  it('never prints the node token or workspace key from the session in --verbose output', async () => {
    const { deps, projectRoot, log, warn, error } = createUpHarness();
    fsReal.writeFileSync(
      pathReal.join(projectRoot, 'agent-relay.mjs'),
      "export default { __agentRelayFleetNode: true, name: 'from-config', capabilities: {}, triggers: [] };\n"
    );

    // Verbose `up` fetches the broker session (which carries nt_live_/rk_live_
    // secrets in the mock) to attach providers; none of it may reach the logs.
    await runUpCommand({ discoverConfig: true, verbose: true }, deps);

    const output = [log, warn, error]
      .flatMap((fn) => vi.mocked(fn).mock.calls.flat())
      .map((arg) => String(arg))
      .join('\n');
    expect(output).not.toMatch(/rk_live_|nt_live_/);
  });

  it('shuts the broker down when its compiled-binary node provider exits', async () => {
    const { deps, projectRoot, error, exit } = createUpHarness();
    const config = pathReal.join(projectRoot, 'agent-relay.mjs');
    fsReal.writeFileSync(
      config,
      "export default { __agentRelayFleetNode: true, name: 'child', capabilities: {}, triggers: [] };\n"
    );
    deps.argv = ['bun', '/$bunfs/root/agent-relay', 'node', 'up'];
    deps.cliScript = '/$bunfs/root/agent-relay';
    deps.holdOpen = async () => delay(100);
    deps.execCommand = vi.fn(async (command: string) => ({
      stdout: command.includes('--describe')
        ? '__AGENT_RELAY_NODE_DESCRIPTOR__{"name":"child","capabilities":[]}\n'
        : '',
      stderr: '',
    }));

    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      killed: false,
      kill: vi.fn(),
    });
    deps.spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('spawn');
        queueMicrotask(() => child.emit('exit', 1, null));
      });
      return child;
    });

    await expect(runUpCommand({ discoverConfig: true }, deps)).rejects.toBeInstanceOf(ExitSignal);

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join('\n')).toContain('exited unexpectedly');
  });
});

// ── repoPaths -> native-broker registration (#1582) ──────────────────────────
// The broker, not the served definition, performs node registration on the
// native path. These assert on what the broker process actually inherits at
// spawn time -- not on the derivation helper in isolation, which would pass
// even with the wiring reverted.
describe('runUpCommand repoPaths registration keys', () => {
  /** Snapshot `deps.env` at the moment the broker process is created. */
  function captureBrokerEnv(deps: CoreDependencies): { env?: NodeJS.ProcessEnv } {
    const captured: { env?: NodeJS.ProcessEnv } = {};
    const inner = deps.createRelay;
    deps.createRelay = vi.fn(async (...args: Parameters<CoreDependencies['createRelay']>) => {
      captured.env = { ...deps.env };
      return inner(...args);
    }) as CoreDependencies['createRelay'];
    return captured;
  }

  it('hands the derived repo keys to the broker when the definition declares repoPaths', async () => {
    const { deps, projectRoot } = createUpHarness();
    const relayPath = pathReal.join(projectRoot, 'checkouts', 'relay');
    const factoryPath = pathReal.join(projectRoot, 'checkouts', 'factory');
    fsReal.writeFileSync(
      pathReal.join(projectRoot, 'agent-relay.mjs'),
      `export default { __agentRelayFleetNode: true, name: 'from-config', capabilities: {}, triggers: [], repoPaths: ${JSON.stringify(
        { 'AgentWorkforce/relay': relayPath, 'AgentWorkforce/factory': factoryPath }
      )} };\n`
    );
    const captured = captureBrokerEnv(deps);

    await runUpCommand({ discoverConfig: true }, deps);

    // Sorted keys only: the absolute checkout paths stay node-local.
    expect(captured.env?.AGENT_RELAY_NODE_REPO_KEYS).toBe('AgentWorkforce/factory,AgentWorkforce/relay');
    expect(captured.env?.AGENT_RELAY_NODE_REPO_KEYS).not.toContain(projectRoot);
  });

  it('hands the descriptor repo keys to the broker on the compiled-binary path', async () => {
    const { deps, projectRoot } = createUpHarness();
    fsReal.writeFileSync(
      pathReal.join(projectRoot, 'agent-relay.mjs'),
      "export default { __agentRelayFleetNode: true, name: 'child', capabilities: {}, triggers: [] };\n"
    );
    deps.argv = ['bun', '/$bunfs/root/agent-relay', 'node', 'up'];
    deps.cliScript = '/$bunfs/root/agent-relay';
    const descriptor = {
      name: 'child',
      capabilities: [],
      repoPaths: { 'AgentWorkforce/relay': pathReal.join(projectRoot, 'checkouts', 'relay') },
    };
    deps.execCommand = vi.fn(async (command: string) => ({
      stdout: command.includes('--describe')
        ? `__AGENT_RELAY_NODE_DESCRIPTOR__${JSON.stringify(descriptor)}\n`
        : '',
      stderr: '',
    }));
    const child = Object.assign(new EventEmitter(), { pid: 42, killed: false, kill: vi.fn() });
    deps.spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const captured = captureBrokerEnv(deps);

    await runUpCommand({ discoverConfig: true }, deps);

    expect(captured.env?.AGENT_RELAY_NODE_REPO_KEYS).toBe('AgentWorkforce/relay');
  });

  it('leaves the broker registration untouched when the definition has no repoPaths', async () => {
    const { deps, projectRoot } = createUpHarness();
    fsReal.writeFileSync(
      pathReal.join(projectRoot, 'agent-relay.mjs'),
      "export default { __agentRelayFleetNode: true, name: 'from-config', capabilities: {}, triggers: [] };\n"
    );
    const captured = captureBrokerEnv(deps);

    await runUpCommand({ discoverConfig: true }, deps);

    expect(captured.env).toBeDefined();
    expect(captured.env).not.toHaveProperty('AGENT_RELAY_NODE_REPO_KEYS');
  });

  it('keeps a pre-set operator declaration verbatim', async () => {
    const { deps, projectRoot } = createUpHarness();
    (deps.env as NodeJS.ProcessEnv).AGENT_RELAY_NODE_REPO_KEYS = 'Operator/override';
    fsReal.writeFileSync(
      pathReal.join(projectRoot, 'agent-relay.mjs'),
      `export default { __agentRelayFleetNode: true, name: 'from-config', capabilities: {}, triggers: [], repoPaths: ${JSON.stringify(
        { 'AgentWorkforce/relay': pathReal.join(projectRoot, 'checkouts', 'relay') }
      )} };\n`
    );
    const captured = captureBrokerEnv(deps);

    await runUpCommand({ discoverConfig: true }, deps);

    expect(captured.env?.AGENT_RELAY_NODE_REPO_KEYS).toBe('Operator/override');
  });

  it('sets nothing when the project has no node definition at all', async () => {
    // The common case, and what CI's standalone smoke exercises: plain `up` in a
    // project with no agent-relay.* file. There is no node plan, so the broker
    // must inherit exactly the environment it did before repo keys existed.
    const { deps } = createUpHarness();
    const captured = captureBrokerEnv(deps);

    await runUpCommand({ discoverConfig: true }, deps);

    expect(captured.env).toBeDefined();
    expect(captured.env).not.toHaveProperty('AGENT_RELAY_NODE_REPO_KEYS');
  });

  it('honors an explicitly empty operator preset over a definition that declares repoPaths', async () => {
    const { deps, projectRoot } = createUpHarness();
    // How an operator clears a CONFIGURED node's stale advertisements. Falling
    // through to the definition here would silently re-publish what they cleared.
    (deps.env as NodeJS.ProcessEnv).AGENT_RELAY_NODE_REPO_KEYS = '';
    fsReal.writeFileSync(
      pathReal.join(projectRoot, 'agent-relay.mjs'),
      `export default { __agentRelayFleetNode: true, name: 'from-config', capabilities: {}, triggers: [], repoPaths: ${JSON.stringify(
        { 'AgentWorkforce/relay': pathReal.join(projectRoot, 'checkouts', 'relay') }
      )} };\n`
    );
    const captured = captureBrokerEnv(deps);

    await runUpCommand({ discoverConfig: true }, deps);

    expect(captured.env?.AGENT_RELAY_NODE_REPO_KEYS).toBe('');
  });

  it('clears stale advertisements with an explicit empty repoPaths map', async () => {
    const { deps, projectRoot } = createUpHarness();
    fsReal.writeFileSync(
      pathReal.join(projectRoot, 'agent-relay.mjs'),
      "export default { __agentRelayFleetNode: true, name: 'from-config', capabilities: {}, triggers: [], repoPaths: {} };\n"
    );
    const captured = captureBrokerEnv(deps);

    await runUpCommand({ discoverConfig: true }, deps);

    // Present-but-empty is distinct from absent: it tells the broker to send
    // `repo_keys: []` and drop what a previous start advertised.
    expect(captured.env).toHaveProperty('AGENT_RELAY_NODE_REPO_KEYS');
    expect(captured.env?.AGENT_RELAY_NODE_REPO_KEYS).toBe('');
  });
});

describe('runUpCommand workspace precedence', () => {
  const readPin = (dataDir: string): Record<string, string> =>
    JSON.parse(fsReal.readFileSync(pathReal.join(dataDir, 'workspace-key.json'), 'utf-8'));
  const readBindingSource = (dataDir: string): string =>
    JSON.parse(fsReal.readFileSync(pathReal.join(dataDir, 'connection.json'), 'utf-8')).workspace_source;

  it('prefers the repository pin over the machine-global active workspace (#1406)', async () => {
    const { deps, dataDir, home, log } = createUpHarness();
    setWorkspaceKey('stale-global', 'rk_stale_global', { AGENT_RELAY_HOME: home });
    writeRepositoryPin(dataDir, { workspaceKey: 'rk_repository', workspaceId: 'rw_repository' });

    await runUpCommand({}, deps);

    expect(deps.env.RELAY_WORKSPACE_KEY).toBe('rk_repository');
    expect(deps.env.RELAY_API_KEY).toBe('rk_repository');
    expect(log.mock.calls.flat().join('\n')).toContain('Workspace source: repository pin');
    expect(readBindingSource(dataDir)).toBe('project');
  });

  it('applies the repository pin even when an enrollment node token is present (#1406)', async () => {
    const { deps, dataDir } = createUpHarness();
    // The harness env already carries RELAY_NODE_TOKEN, which is exactly the
    // condition that used to skip the pin and let the broker mint instead.
    expect(deps.env.RELAY_NODE_TOKEN).toBeTruthy();
    writeRepositoryPin(dataDir, { workspaceKey: 'rk_repository', enrolledNodeId: 'node_a' });

    await runUpCommand({}, deps);

    expect(deps.env.RELAY_WORKSPACE_KEY).toBe('rk_repository');
    expect(deps.env.AGENT_RELAY_ENROLLED_NODE_ID).toBe('node_a');
  });

  it('joins the machine-global active workspace in a fresh directory instead of minting (#1378)', async () => {
    const { deps, home, log } = createUpHarness();
    setWorkspaceKey('account', 'rk_account_active', { AGENT_RELAY_HOME: home });

    await runUpCommand({}, deps);

    expect(deps.env.RELAY_WORKSPACE_KEY).toBe('rk_account_active');
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Workspace source: machine-global active workspace');
    expect(output).toContain('active: "account"');
    expect(output).not.toContain('created new workspace');
    expect(readBindingSource(deps.getProjectPaths().dataDir)).toBe('store');
  });

  it('announces a mint when no source resolves (#1378)', async () => {
    const { deps, dataDir, log } = createUpHarness();

    await runUpCommand({}, deps);

    expect(deps.env.RELAY_WORKSPACE_KEY).toBeUndefined();
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Workspace: none selected');
    expect(output).toContain('Workspace: created new workspace rw_test');
    expect(readBindingSource(dataDir)).toBe('created');
  });

  it('records the workspace source atomically, never truncating connection.json in place (#1429)', async () => {
    const { deps, dataDir } = createUpHarness();
    const connectionPath = pathReal.join(dataDir, 'connection.json');
    const writeFileSpy = vi.spyOn(deps.fs, 'writeFileSync');
    const renameSpy = vi.spyOn(deps.fs, 'renameSync');

    await runUpCommand({}, deps);

    // A concurrent writer to connection.json (e.g. the broker updating its own
    // port/pid) must never be clobbered by a direct, non-atomic overwrite here.
    const directWrites = writeFileSpy.mock.calls.filter(([target]) => target === connectionPath);
    expect(directWrites).toHaveLength(0);

    const renameToConnection = renameSpy.mock.calls.find(([, dest]) => dest === connectionPath);
    expect(renameToConnection).toBeDefined();
    const [tmpPath] = renameToConnection ?? [];
    expect(String(tmpPath)).not.toBe(connectionPath);
    expect(writeFileSpy.mock.calls.some(([target]) => target === tmpPath)).toBe(true);
    expect(readBindingSource(dataDir)).toBe('created');
  });

  it('keeps an explicit --workspace-key ahead of both stores', async () => {
    const { deps, dataDir, home, log } = createUpHarness();
    setWorkspaceKey('global', 'rk_global', { AGENT_RELAY_HOME: home });
    writeRepositoryPin(dataDir, { workspaceKey: 'rk_repository' });

    await runUpCommand({ workspaceKey: 'rk_flag' }, deps);

    expect(deps.env.RELAY_WORKSPACE_KEY).toBe('rk_flag');
    expect(log.mock.calls.flat().join('\n')).toContain('Workspace source: command-line flag');
    expect(readBindingSource(dataDir)).toBe('flag');
  });

  it('attributes provenance to the multi-workspace session, not a single key, when RELAY_WORKSPACES_JSON is set (#1429)', async () => {
    const { deps, dataDir, home, log } = createUpHarness();
    // Every one of these would normally win the single-key ladder, but the
    // broker's startup_session_set_with_options() checks RELAY_WORKSPACES_JSON
    // before any of them, so none is what the broker actually joins.
    setWorkspaceKey('global', 'rk_global', { AGENT_RELAY_HOME: home });
    writeRepositoryPin(dataDir, { workspaceKey: 'rk_repository' });
    deps.env.RELAY_WORKSPACES_JSON = '[{"workspace_id":"rw_a","api_key":"rk_a"}]';

    await runUpCommand({ workspaceKey: 'rk_flag' }, deps);

    expect(log.mock.calls.flat().join('\n')).toContain('Workspace source: multi-workspace session');
    expect(log.mock.calls.flat().join('\n')).toContain('Workspace: joined');
    expect(readBindingSource(dataDir)).toBe('multi-workspace');
  });

  it('records environment provenance after normalizing a workspace-key alias', async () => {
    const { deps, dataDir, log } = createUpHarness();
    deps.env.AGENT_RELAY_WORKSPACE_KEY = ' rk_environment ';

    await runUpCommand({}, deps);

    expect(deps.env.RELAY_WORKSPACE_KEY).toBe('rk_environment');
    expect(log.mock.calls.flat().join('\n')).toContain('$AGENT_RELAY_WORKSPACE_KEY');
    expect(readBindingSource(dataDir)).toBe('env');
  });

  it('records the resolved workspace id on the pin for later conflict detection', async () => {
    const { deps, dataDir } = createUpHarness();

    await runUpCommand({}, deps);

    expect(readPin(dataDir)).toMatchObject({ workspaceKey: 'rk_test', workspaceId: 'rw_test' });
  });

  it('never prints workspace key material while reporting the winning source', async () => {
    const { deps, dataDir, home, log, warn, error } = createUpHarness();
    setWorkspaceKey('global', 'rk_global', { AGENT_RELAY_HOME: home });
    writeRepositoryPin(dataDir, { workspaceKey: 'rk_repository' });

    await runUpCommand({}, deps);

    const output = [log, warn, error]
      .flatMap((fn) => vi.mocked(fn).mock.calls.flat())
      .map((arg) => String(arg))
      .join('\n');
    expect(output).not.toContain('rk_repository');
    expect(output).not.toContain('rk_global');
  });
});

describe('resolveNodeIdentityFromSession', () => {
  const noSleep = vi.fn(async () => {});

  it('returns identity immediately when the token is already present', async () => {
    const getSession = vi.fn(async () => ({
      node_id: 'node-1',
      node_name: 'host-1',
      node_token: 'nt_live_ready',
    }));

    const identity = await resolveNodeIdentityFromSession(getSession, {
      awaitTokenMs: 15_000,
      sleep: noSleep,
    });

    expect(identity).toEqual({ nodeId: 'node-1', nodeName: 'host-1', nodeToken: 'nt_live_ready' });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it('polls until the background-minted token appears', async () => {
    const sessions = [
      { node_id: 'node-1', node_name: 'host-1' },
      { node_id: 'node-1', node_name: 'host-1' },
      { node_id: 'node-1', node_name: 'host-1', node_token: 'nt_live_late' },
    ];
    let call = 0;
    const getSession = vi.fn(async () => sessions[Math.min(call++, sessions.length - 1)]);
    const sleep = vi.fn(async () => {});

    const identity = await resolveNodeIdentityFromSession(getSession, {
      awaitTokenMs: 15_000,
      sleep,
    });

    expect(identity).toEqual({ nodeId: 'node-1', nodeName: 'host-1', nodeToken: 'nt_live_late' });
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not poll when awaitTokenMs is zero (explicit RELAY_NODE_TOKEN path)', async () => {
    const getSession = vi.fn(async () => ({ node_id: 'node-1', node_name: 'host-1' }));
    const sleep = vi.fn(async () => {});

    const identity = await resolveNodeIdentityFromSession(getSession, { awaitTokenMs: 0, sleep });

    expect(identity).toEqual({ nodeId: 'node-1', nodeName: 'host-1' });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns the best identity seen so far when the deadline elapses without a token', async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const getSession = vi.fn(async () => ({ node_id: 'node-1', node_name: 'host-1' }));
    const sleep = vi.fn(async () => {
      now += 200; // advance past the awaitTokenMs budget after the first sleep
    });

    const identity = await resolveNodeIdentityFromSession(getSession, {
      awaitTokenMs: 150,
      sleep,
    });

    expect(identity).toEqual({ nodeId: 'node-1', nodeName: 'host-1' });
    expect(getSession).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('returns null when the broker never reports a node id', async () => {
    const getSession = vi.fn(async () => ({}));

    const identity = await resolveNodeIdentityFromSession(getSession, {
      awaitTokenMs: 15_000,
      sleep: noSleep,
    });

    expect(identity).toBeNull();
  });

  it('yields the last good identity when a later session read throws', async () => {
    let call = 0;
    const getSession = vi.fn(async () => {
      if (call++ === 0) return { node_id: 'node-1', node_name: 'host-1' };
      throw new Error('connection reset');
    });
    const sleep = vi.fn(async () => {});

    const identity = await resolveNodeIdentityFromSession(getSession, {
      awaitTokenMs: 15_000,
      sleep,
    });

    expect(identity).toEqual({ nodeId: 'node-1', nodeName: 'host-1' });
  });

  it('bounds a stalled session read to the token-wait budget instead of hanging', async () => {
    // getSession never resolves; without the per-read bound this would hang past
    // the transport's 30s timeout. With a 60ms budget it must return ~promptly.
    const getSession = vi.fn(() => new Promise<{ node_id?: string }>(() => {}));
    const sleep = vi.fn(async () => {});

    const start = Date.now();
    const identity = await resolveNodeIdentityFromSession(getSession, {
      awaitTokenMs: 60,
      sleep,
    });

    expect(identity).toBeNull();
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(getSession).toHaveBeenCalledTimes(1);
  });
});
