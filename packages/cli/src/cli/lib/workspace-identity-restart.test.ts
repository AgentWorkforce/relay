/**
 * AR-448 regression: a node's workspace — and therefore its resident agent's
 * address and mailbox — must survive a full stop/start.
 *
 * The failure this guards against is quiet. A node started with no repository
 * pin used to fall through to the broker, which mints a brand-new
 * messaging-only workspace. Everything still "works": the broker comes up, the
 * agent registers, `node status` looks healthy — but the agent is a stranger in
 * a different workspace with a new address, so DMs sent to its previous address
 * go nowhere.
 *
 * `broker-lifecycle.test.ts` covers the precedence ladder one start at a time.
 * This file covers what only shows up ACROSS starts: that a second start lands
 * on the same workspace as the first, that the resident keeps its address, and
 * that a checkout which never pinned drifts.
 *
 * ## What is (and is not) exercised
 *
 * These are unit tests over the CLI's own TypeScript — `runUpCommand` and the
 * shared `resolveWorkspaceSelection` ladder. `createRelay` is a stand-in, so no
 * broker binary, released or otherwise, participates. What the stand-in models
 * is the two pieces of real behavior that decide whether identity is durable:
 *
 *   - the broker joins `RELAY_WORKSPACE_KEY` when one is set and otherwise
 *     mints a fresh workspace (`startup_single_session_set_from_sources`,
 *     crates/broker/src/relaycast/auth.rs);
 *   - registration is a fail-closed admission gate (`admit_agent_registration`,
 *     same file). Re-registering a name in a workspace it already belongs to
 *     returns the EXISTING agent — same id, same address, same inbox — only
 *     when the caller proves it is the same work unit. The broker's own startup
 *     registration proves it with `stable_node_identity_key`, derived from the
 *     persisted state directory, which hashes identically across a kill and
 *     restart of the same node and differently for any other node.
 *
 * That second point post-dates the original AR-448 work (commit 5c2ad8ee3),
 * and it narrows what durability means: a restart of the SAME node reclaims its
 * name, while a DIFFERENT node claiming that name in the same workspace is
 * rejected rather than handed the incumbent's credentials.
 */

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
      return {
        node_id: 'node_a',
        node_name: 'the-node',
        broker_version: 'test',
        protocol_version: 2,
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

import { runUpCommand } from './broker-lifecycle.js';
import { readProjectWorkspaceSession } from './project-workspace-key.js';
import type { CoreDependencies } from '../commands/core.js';

/** The resident agent whose address has to survive the restart. */
const RESIDENT_AGENT = 'khaliq-chief';
/** A workspace already selected machine-wide by `agent-relay workspace switch`. */
const CANONICAL_KEY = 'rk_live_canonical0001';

const tmpRoots: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** A registration that the admission gate refused. */
class AdmissionRejected extends Error {
  readonly code = 'agent_identity_mismatch';
}

/**
 * A stand-in for Relaycast shared by every checkout in a test, the way the real
 * cloud is shared by every node on a machine.
 *
 * Workspace keys it mints are globally unique, and each maps to one stable
 * workspace id. Registration mirrors `admit_agent_registration`: a free name is
 * granted, a name already held is reclaimed only on a matching identity proof,
 * and a mismatched or absent proof is rejected outright.
 */
const relaycast = (() => {
  const workspaceIds = new Map<string, string>();
  const agents = new Map<string, { address: string; identity: string }>();
  let mintedWorkspaces = 0;
  let mintedAgents = 0;

  return {
    mintWorkspaceKey(): string {
      const key = `rk_live_minted${(mintedWorkspaces += 1)}`;
      workspaceIds.set(key, `rw_minted${mintedWorkspaces}`);
      return key;
    },
    workspaceIdFor(workspaceKey: string): string {
      const existing = workspaceIds.get(workspaceKey);
      if (existing) return existing;
      // A key the broker joined rather than minted (canonical, pinned, or
      // explicit) still addresses exactly one workspace.
      const id = `rw_joined${workspaceIds.size + 1}`;
      workspaceIds.set(workspaceKey, id);
      return id;
    },
    /** @throws AdmissionRejected when the name is held by another work unit. */
    register(workspaceKey: string, agentName: string, identity: string): string {
      const slot = `${workspaceKey}::${agentName}`;
      const existing = agents.get(slot);
      if (existing) {
        if (existing.identity !== identity) {
          throw new AdmissionRejected(
            `agent name '${agentName}' is already registered and this registration did not prove ownership`
          );
        }
        return existing.address;
      }
      const address = `agent_${(mintedAgents += 1)}@${workspaceKey}`;
      agents.set(slot, { address, identity });
      return address;
    },
    reset(): void {
      workspaceIds.clear();
      agents.clear();
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

interface StartResult {
  workspaceKey: string;
  workspaceId: string;
  /** The resident's delivery address, or `undefined` when admission rejected it. */
  residentAddress?: string;
  rejected?: string;
  log: string[];
}

/**
 * One machine across restarts: a stable project checkout and a stable
 * `AGENT_RELAY_HOME`. Each `start()` builds a fresh env and a fresh dependency
 * set over that same persistent on-disk state, which is exactly what a
 * stop/start looks like from the CLI's point of view — stopping the node is
 * process exit, and nothing in the CLI's own state is carried over.
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

  // The broker derives its own identity proof from its persisted state
  // directory, so it is stable across this machine's restarts and unique to it.
  const nodeIdentity = `node-${dataDir}`;

  async function start(options: { workspaceKey?: string } = {}): Promise<StartResult> {
    const log: string[] = [];
    // A fresh process: only what was persisted to disk crosses the restart.
    const env: NodeJS.ProcessEnv = {
      AGENT_RELAY_HOME: relayHome,
      // A real resident node is Cloud-enrolled. The node token selects node
      // identity, never a workspace, so it must not suppress the ladder.
      RELAY_NODE_TOKEN: 'nt_live_test',
      RELAY_BASE_URL: 'https://engine.test',
    };

    const deps = {
      getProjectPaths: () => ({ projectRoot, dataDir, teamDir: projectRoot }),
      loadTeamsConfig: () => null,
      // Mirrors the broker: join the env-selected workspace, else mint one.
      createRelay: vi.fn(async () => {
        const workspaceKey = env.RELAY_WORKSPACE_KEY?.trim() || relaycast.mintWorkspaceKey();
        return {
          spawn: vi.fn(async () => undefined),
          getStatus: vi.fn(async () => ({})),
          shutdown: vi.fn(async () => undefined),
          workspaceKey,
          workspaceId: relaycast.workspaceIdFor(workspaceKey),
        };
      }),
      spawnProcess: vi.fn(),
      execCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      killProcess: vi.fn(() => {
        throw new Error('not running');
      }),
      fs: {
        existsSync: fsReal.existsSync,
        // The connection file is written by the broker; the stand-in writes
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
      log: (...args: unknown[]) => log.push(args.map(String).join(' ')),
      warn: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as CoreDependencies;

    await runUpCommand(options.workspaceKey ? { workspaceKey: options.workspaceKey } : {}, deps);

    const relay = await vi.mocked(deps.createRelay).mock.results[0]!.value;
    const workspaceKey = relay.workspaceKey as string;
    const workspaceId = relay.workspaceId as string;

    // The resident registers into whatever workspace the broker joined.
    try {
      return {
        workspaceKey,
        workspaceId,
        residentAddress: relaycast.register(workspaceKey, RESIDENT_AGENT, nodeIdentity),
        log,
      };
    } catch (err) {
      if (!(err instanceof AdmissionRejected)) throw err;
      return { workspaceKey, workspaceId, rejected: err.message, log };
    }
  }

  return { start, dataDir, projectRoot };
}

describe('workspace identity across a node stop/start', () => {
  it('keeps one workspace and one resident address across a restart', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await machine.start();
    const second = await machine.start();

    expect(first.workspaceKey).toBe(CANONICAL_KEY);
    expect(second.workspaceKey).toBe(CANONICAL_KEY);
    expect(second.workspaceId).toBe(first.workspaceId);
    // The invariant AR-448 exists for: the address someone recorded before the
    // restart still reaches the resident after it.
    expect(second.residentAddress).toBe(first.residentAddress);
    expect(second.rejected).toBeUndefined();
  });

  it('resumes from the repository pin on the second start, not the machine-global store', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await machine.start();
    const second = await machine.start();

    // The first start joined the canonical workspace and pinned it; the second
    // never has to consult the store at all. Pinning is what makes the identity
    // survive someone later running `workspace switch` machine-wide.
    expect(first.log.join('\n')).toContain('Workspace source: machine-global active workspace');
    expect(readProjectWorkspaceSession(machine.dataDir)?.workspaceKey).toBe(CANONICAL_KEY);
    expect(second.log.join('\n')).toContain('Workspace source: repository pin');
  });

  it('re-pins after an explicit --workspace-key so the next start resumes the new workspace', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const before = await machine.start();
    const moved = await machine.start({ workspaceKey: 'rk_live_explicit0001' });
    const after = await machine.start();

    // Documented migration path: an explicit key outranks both stores AND
    // rewrites the pin, so the move is durable rather than one-shot.
    expect(before.workspaceKey).toBe(CANONICAL_KEY);
    expect(moved.workspaceKey).toBe('rk_live_explicit0001');
    expect(after.workspaceKey).toBe('rk_live_explicit0001');
    expect(after.log.join('\n')).toContain('Workspace source: repository pin');
    // Moving workspaces is exactly the operation that changes an address.
    expect(after.residentAddress).not.toBe(before.residentAddress);
  });

  it('joins the canonical workspace rather than minting on a first start with no pin', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await machine.start();

    expect(first.workspaceKey).toBe(CANONICAL_KEY);
    const output = first.log.join('\n');
    expect(output).toContain(`Workspace: joined ${first.workspaceId}`);
    expect(output).not.toContain('created new workspace');
  });

  it('drifts onto a new workspace per checkout when no canonical workspace is set', async () => {
    // The pre-AR-448 behavior, kept as the negative control: with nothing to
    // anchor identity to, the repository pin is the ONLY thing holding a node
    // together, and a checkout that never pinned starts life somewhere else.
    const machine = createMachine();

    const first = await machine.start();
    const second = await machine.start();

    expect(first.log.join('\n')).toContain('Workspace: created new workspace');
    // The pin written by the first start does hold THIS checkout steady...
    expect(second.workspaceKey).toBe(first.workspaceKey);
    expect(second.residentAddress).toBe(first.residentAddress);

    // ...but a second checkout, with no canonical workspace to join, is a
    // different node in a different workspace entirely.
    const elsewhere = await createMachine().start();
    expect(elsewhere.workspaceKey).not.toBe(first.workspaceKey);
    expect(elsewhere.residentAddress).not.toBe(first.residentAddress);
  });

  it('lands a second checkout in the canonical workspace without anyone copying a key', async () => {
    const original = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });
    const clone = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await original.start();
    const second = await clone.start();

    // Workspace membership converges from the machine-global store alone.
    expect(second.workspaceKey).toBe(first.workspaceKey);
    expect(second.workspaceId).toBe(first.workspaceId);
  });

  it('refuses to hand the resident address to a different node claiming its name', async () => {
    // Narrower than AR-448 originally assumed. Two checkouts converge on one
    // WORKSPACE, but they are not one work unit: registration is a fail-closed
    // admission gate, and only a proof derived from the same state directory
    // reclaims a held name (crates/broker/src/relaycast/auth.rs,
    // `admit_agent_registration` / `stable_node_identity_key`). Handing the
    // incumbent's credentials to whoever asks second is the duplicate-agent
    // failure that gate exists to stop.
    const original = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });
    const clone = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await original.start();
    const second = await clone.start();

    expect(second.workspaceKey).toBe(first.workspaceKey);
    expect(second.residentAddress).toBeUndefined();
    expect(second.rejected).toContain('did not prove ownership');

    // The incumbent is untouched: its own restart still reclaims its address.
    const restarted = await original.start();
    expect(restarted.residentAddress).toBe(first.residentAddress);
  });

  it('never prints workspace key material on any start of the sequence', async () => {
    const machine = createMachine({ canonicalWorkspaceKey: CANONICAL_KEY });

    const first = await machine.start();
    const second = await machine.start();

    const output = [...first.log, ...second.log].join('\n');
    expect(output).toContain('Workspace Key:');
    expect(output).not.toContain(CANONICAL_KEY);
  });
});
