/**
 * AR-448 regression: the canonical workspace, and therefore the resident
 * agent's address, must survive a full node stop/start.
 *
 * The failure this guards against is quiet. A node started with no project pin
 * used to fall through to the broker, which mints a brand-new messaging-only
 * workspace. Everything still "works" — the broker comes up, the agent
 * registers — but the agent is a stranger in a different workspace with a new
 * address, so DMs sent to its old address go nowhere.
 *
 * The harness below models the two pieces of real behavior that make identity
 * durable or not:
 *   - the broker joins `RELAY_WORKSPACE_KEY` when set, and otherwise mints a
 *     fresh workspace (see `startup_single_session_set_from_sources` in
 *     crates/broker/src/relaycast/auth.rs);
 *   - Relaycast returns the EXISTING agent when a name is re-registered in a
 *     workspace it already belongs to, and mints a new one otherwise.
 */

import fsReal from 'node:fs';
import os from 'node:os';
import pathReal from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: class {
    async getSession() {
      return { node_id: 'node_a', node_name: 'the-node', broker_version: 'test', protocol_version: 2 };
    }
    async getStatus() {
      return {};
    }
    disconnect() {}
  },
}));

import { runUpCommand } from './broker-lifecycle.js';
import { readProjectWorkspaceSession } from './project-workspace-key.js';
import type { CoreDependencies } from '../commands/core.js';

const RESIDENT_AGENT = 'khaliq-chief';
const CANONICAL_KEY = 'rk_live_canonical0001';

const tmpRoots: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/**
 * A stand-in for Relaycast, shared by every checkout in a test the way the real
 * cloud is shared by every node: an agent name registered twice in the same
 * workspace keeps its address; the same name in a different workspace is a
 * different agent. Workspace keys it mints are globally unique.
 */
const relaycast = (() => {
  const addresses = new Map<string, string>();
  let mintedWorkspaces = 0;
  let mintedAgents = 0;
  return {
    mintWorkspaceKey: () => `rk_live_minted${(mintedWorkspaces += 1)}`,
    register(workspaceKey: string, agentName: string): string {
      const slot = `${workspaceKey}::${agentName}`;
      const existing = addresses.get(slot);
      if (existing) return existing;
      const address = `agent_${(mintedAgents += 1)}@${workspaceKey}`;
      addresses.set(slot, address);
      return address;
    },
    reset() {
      addresses.clear();
      mintedWorkspaces = 0;
      mintedAgents = 0;
    },
  };
})();

afterEach(() => {
  relaycast.reset();
  for (const dir of tmpRoots.splice(0)) {
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * One machine across restarts: a stable project checkout and a stable
 * `AGENT_RELAY_HOME`. Each `start()` is a fresh CLI process — new env, new
 * deps — over that same persistent state, which is exactly what a stop/start
 * looks like from the CLI's point of view.
 */
function createMachine(options: { canonicalWorkspaceKey?: string } = {}) {
  const projectRoot = mkTmp('ar448-project-');
  const relayHome = mkTmp('ar448-home-');
  const dataDir = pathReal.join(projectRoot, '.agentworkforce', 'relay');
  fsReal.mkdirSync(dataDir, { recursive: true });

  if (options.canonicalWorkspaceKey) {
    fsReal.writeFileSync(
      pathReal.join(relayHome, 'workspaces.json'),
      JSON.stringify({
        active: 'default',
        workspaces: { default: { key: options.canonicalWorkspaceKey } },
      })
    );
  }

  const connection = JSON.stringify({
    url: 'http://127.0.0.1:4999',
    port: 4999,
    api_key: 'test',
    pid: 999999,
  });

  async function start(): Promise<{
    workspaceKey: string;
    residentAddress: string;
    log: string[];
  }> {
    const env: NodeJS.ProcessEnv = { AGENT_RELAY_HOME: relayHome };
    const log: string[] = [];

    const deps = {
      getProjectPaths: () => ({ projectRoot, dataDir, teamDir: projectRoot }),
      loadTeamsConfig: () => null,
      // Mirrors the broker: join the env-selected workspace, or mint a new one.
      createRelay: vi.fn(async () => {
        const workspaceKey = env.RELAY_WORKSPACE_KEY?.trim() || relaycast.mintWorkspaceKey();
        return {
          spawn: vi.fn(async () => undefined),
          getStatus: vi.fn(async () => ({})),
          shutdown: vi.fn(async () => undefined),
          workspaceKey,
        };
      }),
      spawnProcess: vi.fn(),
      execCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      killProcess: vi.fn(() => {
        throw new Error('not running');
      }),
      fs: {
        existsSync: fsReal.existsSync,
        readFileSync: (file: string, encoding: BufferEncoding) =>
          file.endsWith('connection.json') ? connection : fsReal.readFileSync(file, encoding),
        writeFileSync: fsReal.writeFileSync,
        unlinkSync: fsReal.unlinkSync,
        readdirSync: fsReal.readdirSync,
        mkdirSync: fsReal.mkdirSync,
        rmSync: fsReal.rmSync,
        accessSync: fsReal.accessSync,
      },
      generateAgentName: () => RESIDENT_AGENT,
      checkForUpdates: vi.fn(async () => ({ updateAvailable: false })),
      getVersion: () => 'test',
      env,
      argv: ['node', 'agent-relay', 'node', 'up'],
      execPath: process.execPath,
      cliScript: 'cli.js',
      pid: process.pid,
      isPortInUse: vi.fn(async () => false),
      now: () => 0,
      sleep: async () => undefined,
      onSignal: vi.fn(),
      holdOpen: async () => undefined,
      log: (...args: unknown[]) => log.push(args.join(' ')),
      warn: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as CoreDependencies;

    await runUpCommand({ discoverConfig: true }, deps);

    const relay = await vi.mocked(deps.createRelay).mock.results[0]!.value;
    const workspaceKey = relay.workspaceKey as string;
    return {
      workspaceKey,
      residentAddress: relaycast.register(workspaceKey, RESIDENT_AGENT),
      log,
    };
  }

  return { start, dataDir, projectRoot };
}

describe('workspace identity across a node stop/start', () => {
  it('keeps one workspace and one resident address across a restart', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await machine.start();
    // Stopping the node is just process exit — nothing in the CLI's state is
    // torn down, so the second start below is a genuine cold start.
    const second = await machine.start();

    expect(first.workspaceKey).toBe(CANONICAL_KEY);
    expect(second.workspaceKey).toBe(CANONICAL_KEY);
    expect(second.residentAddress).toBe(first.residentAddress);
  });

  it('joins the canonical workspace on a first start with no project pin', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await machine.start();

    // No `--workspace-key`, no env, no pre-existing pin: the canonical
    // workspace is picked up from the machine-global store, not minted.
    expect(first.workspaceKey).toBe(CANONICAL_KEY);
    expect(first.log.join('\n')).toContain('machine-global canonical Agent Relay workspace');
  });

  it('pins the canonical workspace to the project so later starts resume it directly', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    await machine.start();

    expect(readProjectWorkspaceSession(machine.dataDir)?.workspaceKey).toBe(CANONICAL_KEY);
  });

  it('never prints the workspace key that identifies the node', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await machine.start();

    const output = first.log.join('\n');
    expect(output).toContain('Workspace Key:');
    expect(output).not.toContain(CANONICAL_KEY);
  });

  it('mints a throwaway workspace per start when no canonical workspace is set', async () => {
    // The pre-AR-448 behavior, kept as the negative control: with nothing to
    // anchor identity to, the project pin is the ONLY thing holding the node
    // together — and a checkout that never pinned drifts on every start.
    const machine = createMachine();

    const first = await machine.start();
    const second = await machine.start();

    // The pin written by the first start does hold this checkout steady...
    expect(second.workspaceKey).toBe(first.workspaceKey);
    expect(second.residentAddress).toBe(first.residentAddress);

    // ...but a second checkout on the same machine, with no canonical
    // workspace to join, is a different node entirely.
    const otherCheckout = createMachine();
    const elsewhere = await otherCheckout.start();
    expect(elsewhere.workspaceKey).not.toBe(first.workspaceKey);
    expect(elsewhere.residentAddress).not.toBe(first.residentAddress);
  });

  it('lets a second checkout share the canonical workspace and the resident address', async () => {
    // A Chief moved to a new clone, or a second Chief on the same company
    // workspace, resolves it without anyone copying a key by hand.
    const original = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });
    const clone = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await original.start();
    const second = await clone.start();

    expect(second.workspaceKey).toBe(first.workspaceKey);
    expect(second.residentAddress).toBe(first.residentAddress);
  });
});

describe('explicit workspace selection still wins', () => {
  it('does not override an explicit --workspace-key with the canonical store', async () => {
    const projectRoot = mkTmp('ar448-explicit-');
    const relayHome = mkTmp('ar448-explicit-home-');
    fsReal.mkdirSync(pathReal.join(projectRoot, '.agentworkforce', 'relay'), { recursive: true });
    fsReal.writeFileSync(
      pathReal.join(relayHome, 'workspaces.json'),
      JSON.stringify({ active: 'default', workspaces: { default: { key: CANONICAL_KEY } } })
    );

    const env: NodeJS.ProcessEnv = { AGENT_RELAY_HOME: relayHome };
    const deps = {
      getProjectPaths: () => ({
        projectRoot,
        dataDir: pathReal.join(projectRoot, '.agentworkforce', 'relay'),
        teamDir: projectRoot,
      }),
      loadTeamsConfig: () => null,
      createRelay: vi.fn(async () => ({
        spawn: vi.fn(async () => undefined),
        getStatus: vi.fn(async () => ({})),
        shutdown: vi.fn(async () => undefined),
        workspaceKey: env.RELAY_WORKSPACE_KEY,
      })),
      spawnProcess: vi.fn(),
      execCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      killProcess: vi.fn(() => {
        throw new Error('not running');
      }),
      fs: {
        existsSync: fsReal.existsSync,
        readFileSync: (file: string, encoding: BufferEncoding) =>
          file.endsWith('connection.json')
            ? JSON.stringify({ url: 'http://127.0.0.1:4999', port: 4999, api_key: 't', pid: 999999 })
            : fsReal.readFileSync(file, encoding),
        writeFileSync: fsReal.writeFileSync,
        unlinkSync: fsReal.unlinkSync,
        readdirSync: fsReal.readdirSync,
        mkdirSync: fsReal.mkdirSync,
        rmSync: fsReal.rmSync,
        accessSync: fsReal.accessSync,
      },
      generateAgentName: () => RESIDENT_AGENT,
      checkForUpdates: vi.fn(async () => ({ updateAvailable: false })),
      getVersion: () => 'test',
      env,
      argv: ['node', 'agent-relay', 'node', 'up'],
      execPath: process.execPath,
      cliScript: 'cli.js',
      pid: process.pid,
      isPortInUse: vi.fn(async () => false),
      now: () => 0,
      sleep: async () => undefined,
      onSignal: vi.fn(),
      holdOpen: async () => undefined,
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as CoreDependencies;

    await runUpCommand({ discoverConfig: true, workspaceKey: 'rk_live_explicit0001' }, deps);

    expect(env.RELAY_WORKSPACE_KEY).toBe('rk_live_explicit0001');
  });
});
