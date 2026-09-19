import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fleetNodeEnrollmentStorePath } from '@agent-relay/cloud';

import {
  acquireNodeClaim,
  adoptNodeClaim,
  closeNodeClaimHold,
  describeNodeClaimHolder,
  enrolledNodeIdForClaim,
  findLiveStateDirBroker,
  hasCachedNodeToken,
  inspectNodeClaim,
  listHeldNodeClaims,
  listNodeClaims,
  nodeClaimHoldPath,
  nodeClaimPath,
  nodeClaimsDir,
  NodeClaimConflictError,
  NodeClaimHoldError,
  openNodeClaimHold,
  readNodeClaim,
  releaseNodeClaim,
  releaseNodeClaimsForBroker,
  type NodeClaim,
} from './node-claim.js';

const tmpRoots: string[] = [];

/**
 * A scratch `AGENT_RELAY_HOME` so no test reads the developer's real claims.
 * `HOME`/`XDG_DATA_HOME` are pinned too: the cached-node-token probe resolves
 * the broker's `dirs::data_local_dir()` from those, and must not find (or miss)
 * a token because of the machine the suite happens to run on.
 */
function createHome(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-home-'));
  tmpRoots.push(home);
  return {
    AGENT_RELAY_HOME: path.join(home, 'relay'),
    HOME: home,
    XDG_DATA_HOME: path.join(home, 'data'),
  };
}

function createStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-state-'));
  tmpRoots.push(dir);
  return dir;
}

/** Cache a node token where the broker's `resolve_cached_node_token` reads it. */
function writeCachedNodeToken(env: NodeJS.ProcessEnv, nodeId: string): void {
  const file = path.join(env.XDG_DATA_HOME!, 'agent-relay', 'node-tokens', `${nodeId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ node_id: nodeId, workspace_id: 'ws_test', token: 'nt_live_cached' })
  );
}

/** The connection file the Rust broker writes into its state dir on startup. */
function writeConnectionFile(stateDir: string, pid: number): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'connection.json'),
    JSON.stringify({ url: 'http://localhost:3891', port: 3891, api_key: 'k', pid })
  );
}

/** `ps` stubs: a fixed birth time, and a command line that looks like a broker. */
function psDeps(overrides: { args?: string; lstart?: string } = {}) {
  return async (command: string) => {
    if (command.includes('-o args=')) {
      return { stdout: overrides.args ?? '/usr/local/bin/agent-relay broker --persist\n', stderr: '' };
    }
    return { stdout: overrides.lstart ?? 'Thu Sep 10 18:00:00 2026\n', stderr: '' };
  };
}

/**
 * Dependencies whose `ps` lookup yields to the event loop, so two concurrent
 * acquisitions really do interleave at their await points — the interleaving
 * that let both of them observe the same absent-or-stale claim and both win.
 */
function concurrentDeps(env: NodeJS.ProcessEnv, alive: number[]) {
  return {
    env,
    execCommand: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { stdout: 'Thu Sep 10 18:00:00 2026', stderr: '' };
    },
    killProcess: (pid: number) => {
      if (!alive.includes(pid)) throw new Error(`no such process ${pid}`);
    },
  };
}

function writeClaim(
  env: NodeJS.ProcessEnv,
  claim: Partial<NodeClaim> & { node_id: string; pid: number },
  generation = 1
): NodeClaim {
  const full: NodeClaim = {
    version: 1,
    state_dir: '/repo/.agentworkforce/relay',
    claimed_at: '2026-10-05T12:00:00.000Z',
    generation,
    ...claim,
  };
  const file = nodeClaimPath(full.node_id, env, generation);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

/**
 * A real shell runner, for the checks that must reach the kernel rather than a
 * stub: the hold-descriptor probe is only evidence if `lsof` really answers it.
 */
function realExec(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Stand in for a supervisor that opened its claim's hold descriptor, spawned a
 * broker that inherited it, and was then SIGKILLed before the child published
 * anything at all.
 *
 * The child is a plain sleeper: it never writes `connection.json`, never binds
 * a port and never registers, which is exactly the orphan the old "dead
 * supervisor, nothing on disk" reading declared stale.
 */
async function spawnHoldingChild(
  claim: NodeClaim,
  env: NodeJS.ProcessEnv,
  options: { brokerLikeArgv?: boolean; executable?: string } = {}
) {
  const { brokerLikeArgv = true, executable = process.execPath } = options;
  const fd = openNodeClaimHold(claim, env);
  expect(fd).toBeDefined();
  // The real broker is `agent-relay-broker --state-dir <dir>`; carry the state
  // dir in argv so this stand-in is recognisable to a claim that records no
  // broker executable, exactly as such a broker would be.
  const argv = ['-e', 'setTimeout(() => {}, 60_000)', ...(brokerLikeArgv ? [claim.state_dir] : [])];
  const child = spawn(executable, argv, {
    stdio: ['ignore', 'ignore', 'ignore', fd!],
  });
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  // The supervisor is gone; only the child's inherited descriptor remains.
  closeNodeClaimHold(fd);
  return {
    pid: child.pid!,
    async kill(): Promise<void> {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
}

/**
 * A broker executable under an operator-chosen filename.
 *
 * `AGENT_RELAY_BIN` / `BROKER_BINARY_PATH` make the broker's filename the
 * operator's choice, so this is a supported deployment — and one whose argv
 * says nothing about Relay. A symlink keeps the executable's device and inode
 * (what the claim records and what `lsof -d txt` reports) those of a real
 * binary, without copying one.
 */
function createCustomBrokerBinary(name = 'custom-broker'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-bin-'));
  tmpRoots.push(dir);
  const binary = path.join(dir, name);
  fs.symlinkSync(process.execPath, binary);
  return binary;
}

/** A live process to stand in for a broker another start left registered. */
async function spawnSleeper(executable = process.execPath) {
  const child = spawn(executable, ['-e', 'setTimeout(() => {}, 60_000)']);
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  return {
    pid: child.pid!,
    async kill(): Promise<void> {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
}

/** A pid that is guaranteed dead: spawned, then observed to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('inspectNodeClaim', () => {
  it('reports an unclaimed node when no claim file exists', async () => {
    const env = createHome();

    await expect(inspectNodeClaim('node_1', { env })).resolves.toEqual({ state: 'unclaimed' });
  });

  it('reports a claim whose pid is running as held', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: process.pid });

    const status = await inspectNodeClaim('node_1', { env });

    expect(status.state).toBe('held');
  });

  it('reports a claim whose pid is gone as stale', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: await deadPid() });

    const status = await inspectNodeClaim('node_1', { env });

    expect(status).toMatchObject({ state: 'stale' });
    expect(status.state === 'stale' && status.reason).toContain('no longer running');
  });

  it('reports a recycled pid as stale even though the process is alive', async () => {
    const env = createHome();
    writeClaim(env, {
      node_id: 'node_1',
      pid: process.pid,
      process_started_at: 'Mon Oct 5 09:00:00 2026',
    });

    const status = await inspectNodeClaim('node_1', {
      env,
      execCommand: async () => ({ stdout: 'Tue Oct 6 11:00:00 2026\n', stderr: '' }),
    });

    expect(status).toMatchObject({ state: 'stale' });
    expect(status.state === 'stale' && status.reason).toContain('recycled');
  });

  it('keeps a claim held when its birth time cannot be read', async () => {
    const env = createHome();
    writeClaim(env, {
      node_id: 'node_1',
      pid: process.pid,
      process_started_at: 'Mon Oct 5 09:00:00 2026',
    });

    const status = await inspectNodeClaim('node_1', {
      env,
      execCommand: async () => {
        throw new Error('ps: command not found');
      },
    });

    // Refusing is recoverable; a wrong "free" verdict silently cuts delivery.
    expect(status.state).toBe('held');
  });

  it('treats a permission-denied liveness probe as held', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: 4242 });

    const status = await inspectNodeClaim('node_1', {
      env,
      killProcess: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    });

    expect(status.state).toBe('held');
  });

  it('ignores a malformed claim file instead of bricking startup', async () => {
    const env = createHome();
    const file = nodeClaimPath('node_1', env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');

    await expect(inspectNodeClaim('node_1', { env })).resolves.toEqual({ state: 'unclaimed' });
    expect(readNodeClaim('node_1', env)).toBeNull();
  });

  it('refuses to overwrite a claim file that records a different node id', async () => {
    const env = createHome();
    // A sanitized filename collision must not silently drop the other claim.
    const file = nodeClaimPath('node_1', env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        node_id: 'node_other',
        pid: process.pid,
        state_dir: '/repo/.agentworkforce/relay',
        claimed_at: '2026-10-05T12:00:00.000Z',
      })
    );

    const status = await inspectNodeClaim('node_1', { env });

    expect(status).toMatchObject({ state: 'held' });
    expect(status.state === 'held' && status.reason).toContain('node_other');
  });

  it('reads the newest generation, not the first one written', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: '/old' }, 1);
    writeClaim(env, { node_id: 'node_1', pid: process.pid, state_dir: '/new' }, 2);

    const status = await inspectNodeClaim('node_1', { env });

    expect(status).toMatchObject({ state: 'held' });
    expect(status.state === 'held' && status.claim.state_dir).toBe('/new');
  });
});

describe('inspectNodeClaim with an orphaned broker', () => {
  it('keeps a reservation held when the supervisor was killed before it recorded the broker', async () => {
    // The crash window: `node up` reserved the node id, spawned a broker that
    // wrote its connection file (and can already have registered), then was
    // SIGKILLed before it could record the broker's pid. Reading that claim as
    // stale is what lets the next start evict a live delivery socket.
    const env = createHome();
    const stateDir = createStateDir();
    writeConnectionFile(stateDir, process.pid);
    writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      status: 'reserved',
      state_dir: stateDir,
    });

    const status = await inspectNodeClaim('node_1', { env, execCommand: psDeps() });

    expect(status.state).toBe('held');
    expect(status.state === 'held' && status.reason).toContain('connection.json');
    expect(status.state === 'held' && status.claim.pid).toBe(process.pid);
  });

  it('ignores a connection file whose pid is no longer running', async () => {
    const env = createHome();
    const stateDir = createStateDir();
    writeConnectionFile(stateDir, await deadPid());
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: stateDir });

    await expect(inspectNodeClaim('node_1', { env, execCommand: psDeps() })).resolves.toMatchObject({
      state: 'stale',
    });
  });

  it('ignores a connection file whose pid belongs to an unrelated program', async () => {
    const env = createHome();
    const stateDir = createStateDir();
    writeConnectionFile(stateDir, process.pid);
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: stateDir });

    const status = await inspectNodeClaim('node_1', {
      env,
      execCommand: psDeps({ args: '/usr/bin/some-other-program --unrelated' }),
    });

    expect(status.state).toBe('stale');
  });

  it('reports the live broker serving a state dir', async () => {
    const stateDir = createStateDir();
    writeConnectionFile(stateDir, process.pid);

    await expect(findLiveStateDirBroker(stateDir, { execCommand: psDeps() })).resolves.toMatchObject({
      pid: process.pid,
    });
  });

  it('reports no broker for a state dir with no connection file', async () => {
    await expect(findLiveStateDirBroker(createStateDir(), { execCommand: psDeps() })).resolves.toBeNull();
  });
});

describe('acquireNodeClaim', () => {
  it('records the holding broker and survives a reread', async () => {
    const env = createHome();

    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/.agentworkforce/relay',
      apiPort: 3891,
      brokerName: 'kjglaptop',
      env,
    });

    expect(claim).toMatchObject({
      version: 1,
      node_id: 'node_1',
      pid: process.pid,
      api_port: 3891,
      broker_name: 'kjglaptop',
      generation: 1,
    });
    expect(readNodeClaim('node_1', env)).toEqual(claim);
    expect(fs.existsSync(nodeClaimsDir(env))).toBe(true);
    expect(describeNodeClaimHolder(claim)).toContain(`pid ${process.pid}`);
  });

  it('refuses when a live broker already holds the node id', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: process.pid, state_dir: '/other/state' });

    await expect(
      acquireNodeClaim({ nodeId: 'node_1', pid: 424242, stateDir: '/repo/state', env })
    ).rejects.toBeInstanceOf(NodeClaimConflictError);
    // The live broker's claim is left exactly as it was.
    expect(readNodeClaim('node_1', env)?.state_dir).toBe('/other/state');
  });

  it('refuses when an orphaned broker still serves the claimed state dir', async () => {
    const env = createHome();
    const stateDir = createStateDir();
    writeConnectionFile(stateDir, process.pid);
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: stateDir });

    await expect(
      acquireNodeClaim({
        nodeId: 'node_1',
        pid: 424242,
        stateDir: '/repo/state',
        env,
        execCommand: psDeps(),
      })
    ).rejects.toBeInstanceOf(NodeClaimConflictError);
  });

  it('takes over a live claim when forced', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: process.pid, state_dir: '/other/state' });

    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: 424242,
      stateDir: '/repo/state',
      env,
      force: true,
    });

    expect(claim.pid).toBe(424242);
    expect(claim.generation).toBe(2);
    expect(readNodeClaim('node_1', env)?.state_dir).toBe('/repo/state');
  });

  it('takes over a claim left by a dead broker without --force', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: '/other/state' });

    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      env,
    });

    expect(claim.pid).toBe(process.pid);
    // The superseded generation is cleaned up, so files cannot pile up per boot.
    expect(fs.existsSync(nodeClaimPath('node_1', env, 1))).toBe(false);
  });

  it('lets the same broker refresh its own claim', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: process.pid, state_dir: '/repo/state' });

    await expect(
      acquireNodeClaim({ nodeId: 'node_1', pid: process.pid, stateDir: '/repo/state', env })
    ).resolves.toMatchObject({ pid: process.pid });
  });

  it('steps over a generation another start already created', async () => {
    const env = createHome();
    // A generation file that is not a readable claim still has to raise the
    // next number, or the exclusive create would collide with it forever.
    const orphan = nodeClaimPath('node_1', env, 4);
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'torn');

    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      env,
    });

    expect(claim.generation).toBe(5);
  });
});

describe('acquireNodeClaim exclusion', () => {
  it('lets exactly one of two concurrent starts claim an unclaimed node', async () => {
    const env = createHome();
    const deps = concurrentDeps(env, [111, 222]);

    const results = await Promise.allSettled([
      acquireNodeClaim({ nodeId: 'node_1', pid: 111, stateDir: '/checkout-a', ...deps }),
      acquireNodeClaim({ nodeId: 'node_1', pid: 222, stateDir: '/checkout-b', ...deps }),
    ]);

    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(NodeClaimConflictError);
    // The surviving file is the winner's, not a mix of both writes.
    const winner = (winners[0] as PromiseFulfilledResult<NodeClaim>).value;
    expect(readNodeClaim('node_1', env)).toMatchObject({
      pid: winner.pid,
      state_dir: winner.state_dir,
    });
  });

  it('lets exactly one of two concurrent starts take over a stale claim', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: '/gone' });
    const deps = concurrentDeps(env, [111, 222]);

    const results = await Promise.allSettled([
      acquireNodeClaim({ nodeId: 'node_1', pid: 111, stateDir: '/checkout-a', ...deps }),
      acquireNodeClaim({ nodeId: 'node_1', pid: 222, stateDir: '/checkout-b', ...deps }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(NodeClaimConflictError);
    expect([111, 222]).toContain(readNodeClaim('node_1', env)?.pid);
  });

  it('loses to a competitor that takes the generation between the scan and the create', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: '/gone' });
    let planted = false;

    // Drive the exact filesystem interleaving another process would produce:
    // while this acquisition is still resolving birth times, the competitor
    // creates the very generation it was about to claim.
    const claim = acquireNodeClaim({
      nodeId: 'node_1',
      pid: 111,
      stateDir: '/checkout-a',
      env,
      killProcess: (pid: number) => {
        if (pid !== 222) throw new Error(`no such process ${pid}`);
      },
      execCommand: async () => {
        if (!planted) {
          planted = true;
          writeClaim(env, { node_id: 'node_1', pid: 222, state_dir: '/checkout-b' }, 2);
        }
        return { stdout: 'Thu Sep 10 18:00:00 2026', stderr: '' };
      },
    });

    await expect(claim).rejects.toBeInstanceOf(NodeClaimConflictError);
    // The competitor's record is untouched: no write of ours landed on it.
    expect(readNodeClaim('node_1', env)).toMatchObject({ pid: 222, state_dir: '/checkout-b' });
  });

  it('gives the node up when a competitor wins a higher generation during the write', async () => {
    const env = createHome();
    let planted = false;

    const claim = acquireNodeClaim({
      nodeId: 'node_1',
      pid: 111,
      stateDir: '/checkout-a',
      env,
      killProcess: (pid: number) => {
        if (pid !== 222) throw new Error(`no such process ${pid}`);
      },
      execCommand: async () => {
        if (!planted) {
          planted = true;
          // The competitor read our generation as takeable and went past it.
          writeClaim(env, { node_id: 'node_1', pid: 222, state_dir: '/checkout-b' }, 9);
        }
        return { stdout: 'Thu Sep 10 18:00:00 2026', stderr: '' };
      },
    });

    await expect(claim).rejects.toBeInstanceOf(NodeClaimConflictError);
    expect(readNodeClaim('node_1', env)).toMatchObject({ pid: 222 });
    // Ours is withdrawn rather than left behind looking live.
    expect(fs.existsSync(nodeClaimPath('node_1', env, 1))).toBe(false);
  });

  it('refuses a node id a successor took while this start was suspended mid-acquire', async () => {
    const env = createHome();
    // The stale claim both this start and the takeover cycle below read.
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: '/gone' });
    let interleaved = false;
    let successor: NodeClaim | undefined;

    // A start that read the generations and then lost the CPU. While it is
    // suspended, a complete acquire/release/re-acquire cycle runs: the release
    // is what used to make its generation number available again, so this start
    // could wake up, re-create a number that had already been handed out, pass
    // the higher-generation check and prune the successor's live claim from its
    // own stale scan — two live brokers on one node id, one of them recorded.
    const suspended = acquireNodeClaim({
      nodeId: 'node_1',
      pid: 111,
      stateDir: '/checkout-a',
      env,
      killProcess: (pid: number) => {
        if (pid !== 222) throw new Error(`no such process ${pid}`);
      },
      execCommand: async () => {
        if (!interleaved) {
          interleaved = true;
          const intermediate = await acquireNodeClaim({
            nodeId: 'node_1',
            pid: 333,
            stateDir: '/checkout-b',
            env,
            killProcess: (pid: number) => {
              if (pid !== 333) throw new Error(`no such process ${pid}`);
            },
            execCommand: psDeps(),
          });
          // `node down` on the intermediate start: the node id genuinely frees.
          await expect(releaseNodeClaim(intermediate, env)).resolves.toBe(true);
          successor = await acquireNodeClaim({
            nodeId: 'node_1',
            pid: 222,
            stateDir: '/checkout-c',
            env,
            killProcess: (pid: number) => {
              if (pid !== 222) throw new Error(`no such process ${pid}`);
            },
            execCommand: psDeps(),
          });
        }
        return { stdout: 'Thu Sep 10 18:00:00 2026', stderr: '' };
      },
    });

    await expect(suspended).rejects.toBeInstanceOf(NodeClaimConflictError);
    // The successor is still alive, still owns the node id, and still has its
    // record: nothing the suspended start did reached another acquisition.
    expect(readNodeClaim('node_1', env)).toMatchObject({ pid: 222, state_dir: '/checkout-c' });
    expect(fs.existsSync(nodeClaimPath('node_1', env, successor!.generation ?? 1))).toBe(true);
  });

  it('never reissues a generation number once it has been released', async () => {
    const env = createHome();
    const generations: number[] = [];
    for (let start = 0; start < 4; start += 1) {
      const claim = await acquireNodeClaim({
        nodeId: 'node_1',
        pid: process.pid,
        stateDir: '/repo/state',
        env,
        execCommand: psDeps(),
      });
      generations.push(claim.generation ?? 1);
      await releaseNodeClaim(claim, env);
      // Released reads as free straight away — the spent number is not a claim.
      expect(readNodeClaim('node_1', env)).toBeNull();
    }

    expect(generations).toEqual([1, 2, 3, 4]);
    // One spent file per node id at rest: each acquisition prunes the last.
    expect(fs.readdirSync(nodeClaimsDir(env))).toHaveLength(1);
  });

  it('refuses to win beneath a generation that was spent while this start was suspended', async () => {
    // The reviewer's interleaving, and the case the successor test above misses:
    // every start that raised the generation number has RELEASED, so the only
    // file above the suspended start is a tombstone. Skipping tombstones when
    // confirming the create let that start declare itself the owner of a low
    // number, while a start that had already read the tombstone went on to
    // create `max + 1`. Neither one's prune list names the other, so both stay
    // live and both spawn.
    const env = createHome();
    const alive = new Set([111, 444]);
    const liveness = (pid: number): void => {
      if (!alive.has(pid)) throw new Error(`no such process ${pid}`);
    };
    let suspendLater: () => void = () => undefined;
    const laterIsSuspended = new Promise<void>((resolve) => {
      suspendLater = resolve;
    });
    let resumeLater: () => void = () => undefined;
    const laterMayResume = new Promise<void>((resolve) => {
      resumeLater = resolve;
    });
    let laterSuspended = false;
    let interleaved = false;
    let later: Promise<NodeClaim> | undefined;

    // The start that scanned an EMPTY store and then lost the CPU inside
    // `buildClaim`, before it could create generation 1.
    const suspended = acquireNodeClaim({
      nodeId: 'node_1',
      pid: 111,
      stateDir: '/checkout-a',
      env,
      killProcess: liveness,
      execCommand: async () => {
        if (!interleaved) {
          interleaved = true;
          // Two complete start/stop cycles retire generations 1 and 2, leaving
          // no claim at all: the node id is genuinely free, and the only file
          // on disk is generation 2's tombstone.
          for (const pid of [222, 333]) {
            const spent = await acquireNodeClaim({
              nodeId: 'node_1',
              pid,
              stateDir: `/checkout-${pid}`,
              env,
              killProcess: () => undefined,
              execCommand: psDeps(),
            });
            await expect(releaseNodeClaim(spent, env)).resolves.toBe(true);
          }
          // A start that reads that tombstone and picks generation 3, then
          // suspends before creating it — exactly where the old code let the
          // start below take generation 1 underneath it.
          later = acquireNodeClaim({
            nodeId: 'node_1',
            pid: 444,
            stateDir: '/checkout-d',
            env,
            killProcess: liveness,
            execCommand: async () => {
              if (!laterSuspended) {
                laterSuspended = true;
                suspendLater();
                await laterMayResume;
              }
              return { stdout: 'Thu Sep 10 18:00:00 2026', stderr: '' };
            },
          });
          await laterIsSuspended;
        }
        return { stdout: 'Thu Sep 10 18:00:00 2026', stderr: '' };
      },
    });

    // The suspended start may still own the node id — nothing is serving it —
    // but only above every number ever issued for the stem.
    const winner = await suspended;
    expect(winner.generation).toBeGreaterThan(2);
    resumeLater();
    // And the start that had already read the tombstone loses, instead of
    // creating a second live claim beside it.
    await expect(later).rejects.toBeInstanceOf(NodeClaimConflictError);
    expect(readNodeClaim('node_1', env)).toMatchObject({ pid: 111, state_dir: '/checkout-a' });
    const live = fs
      .readdirSync(nodeClaimsDir(env))
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(nodeClaimsDir(env), name), 'utf8')) as NodeClaim)
      .filter((record) => (record as unknown as { released?: boolean }).released !== true);
    expect(live).toHaveLength(1);
  });

  it('lets exactly one of six separate OS processes take over a stale claim', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: await deadPid(), state_dir: '/gone' });

    const outcomes = await raceRealProcesses(env, 6);

    // Same-process tests cannot interleave adjacent synchronous syscalls; this
    // one runs the real protocol in six independent OS processes.
    expect(outcomes.filter((outcome) => outcome === 'won')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'NodeClaimConflictError')).toHaveLength(5);
  }, 30_000);

  it('refuses a node whose dead supervisor left a live broker, even holding its recycled pid', async () => {
    // The reservation records a supervisor that is long gone. The OS has since
    // reissued its pid to THIS start — the one case the old pid-equality
    // exemption read as "our own claim, take it back" — while the broker that
    // supervisor spawned is still registered and serving.
    const env = createHome();
    const stateDir = createStateDir();
    const orphan = await spawnSleeper();
    try {
      writeClaim(env, {
        node_id: 'node_1',
        pid: process.pid,
        supervisor_pid: process.pid,
        process_started_at: 'Mon Oct 5 09:00:00 2026',
        state_dir: stateDir,
        status: 'reserved',
      });
      writeConnectionFile(stateDir, orphan.pid);

      await expect(
        acquireNodeClaim({
          nodeId: 'node_1',
          pid: process.pid,
          stateDir: '/other/checkout/state',
          env,
          execCommand: psDeps(),
        })
      ).rejects.toBeInstanceOf(NodeClaimConflictError);

      // Nothing was taken: the incumbent's generation is still the one on disk.
      expect(fs.existsSync(nodeClaimPath('node_1', env, 2))).toBe(false);
      expect(readNodeClaim('node_1', env)).toMatchObject({ state_dir: stateDir });
    } finally {
      await orphan.kill();
    }
  });

  it("refuses over a supervisor-less child while holding the dead supervisor's recycled pid", async () => {
    // Same recycled-pid start, against the earlier orphan: a child that has not
    // published anything yet and is known only by the descriptor it inherited.
    const env = createHome();
    const stateDir = createStateDir();
    const claim = writeClaim(env, {
      node_id: 'node_1',
      pid: process.pid,
      supervisor_pid: process.pid,
      process_started_at: 'Mon Oct 5 09:00:00 2026',
      state_dir: stateDir,
      status: 'reserved',
    });
    const child = await spawnHoldingChild(claim, env);

    try {
      await expect(
        acquireNodeClaim({
          nodeId: 'node_1',
          pid: process.pid,
          stateDir: '/other/checkout/state',
          env,
          execCommand: realExec,
        })
      ).rejects.toBeInstanceOf(NodeClaimConflictError);
    } finally {
      await child.kill();
    }
  });

  it('still lets a start re-take its own claim when nothing else is serving it', async () => {
    // The exemption that survives: our own pid is not evidence of a competing
    // broker, so a legitimate refresh must not be refused by the fix above.
    const env = createHome();
    const stateDir = createStateDir();
    writeClaim(env, {
      node_id: 'node_1',
      pid: process.pid,
      supervisor_pid: process.pid,
      process_started_at: 'Mon Oct 5 09:00:00 2026',
      state_dir: stateDir,
      status: 'reserved',
    });

    await expect(
      acquireNodeClaim({ nodeId: 'node_1', pid: process.pid, stateDir, env, execCommand: realExec })
    ).resolves.toMatchObject({ generation: 2, pid: process.pid });
  });
});

/**
 * Run `acquireNodeClaim` for one node id in `count` real OS processes, released
 * simultaneously, and report what each one saw.
 *
 * The module is transpiled to a standalone ESM file (it imports nothing but
 * node builtins) so a child can load the actual source under test.
 */
async function raceRealProcesses(env: NodeJS.ProcessEnv, count: number): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-race-'));
  tmpRoots.push(dir);
  const moduleFile = path.join(dir, 'node-claim.mjs');
  esbuild.buildSync({
    entryPoints: [fileURLToPath(new URL('./node-claim.ts', import.meta.url))],
    outfile: moduleFile,
    format: 'esm',
    platform: 'node',
    target: 'node20',
  });
  const gate = path.join(dir, 'go');
  const runner = path.join(dir, 'runner.mjs');
  fs.writeFileSync(
    runner,
    `import fs from 'node:fs';
import { acquireNodeClaim } from ${JSON.stringify(moduleFile)};
const [gate, home, stateDir] = process.argv.slice(2);
process.stdout.write('ready\\n');
while (!fs.existsSync(gate)) {}
try {
  await acquireNodeClaim({ nodeId: 'node_1', pid: process.pid, stateDir, env: { AGENT_RELAY_HOME: home } });
  process.stdout.write('won\\n');
  // Stay alive: a winner that exits at once reads as a dead pid, and the next
  // process would legitimately take the node over instead of losing to it.
  await new Promise((resolve) => setTimeout(resolve, 2000));
} catch (error) {
  process.stdout.write(\`\${error.name}\\n\`);
}
`
  );

  const children = Array.from({ length: count }, (_, index) =>
    spawn(process.execPath, [runner, gate, env.AGENT_RELAY_HOME!, `/checkout-${index}`], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  );
  const outputs = children.map(() => '');
  const ready: Promise<void>[] = children.map(
    (child, index) =>
      new Promise((resolve) => {
        child.stdout.on('data', (chunk: Buffer) => {
          outputs[index] += chunk.toString();
          if (outputs[index].includes('ready\n')) resolve();
        });
      })
  );
  const exits = children.map((child) => new Promise<void>((resolve) => child.once('close', () => resolve())));
  await Promise.all(ready);
  fs.writeFileSync(gate, 'go');
  await Promise.all(exits);
  return outputs.map((output) => output.split('\n').filter(Boolean)[1] ?? 'no-result');
}

describe('claim hold descriptor', () => {
  it('holds a reservation whose supervisor died with the child paused before publication', async () => {
    const env = createHome();
    // Deliberately empty: the child has bound nothing and written nothing, so
    // `connection.json` — the evidence that used to carry this case — does not
    // exist yet. This is the spawn-to-publication window.
    const stateDir = createStateDir();
    const claim = writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      state_dir: stateDir,
      status: 'reserved',
    });
    const child = await spawnHoldingChild(claim, env);

    try {
      const status = await inspectNodeClaim('node_1', { env, execCommand: realExec });

      expect(status.state).toBe('held');
      expect(status.state === 'held' && status.reason).toContain(String(child.pid));
      // The operator is pointed at the process that actually holds the node,
      // not at the supervisor pid the record still names and that is dead.
      expect(status.state === 'held' && status.claim.pid).toBe(child.pid);
      expect(fs.existsSync(path.join(stateDir, 'connection.json'))).toBe(false);
    } finally {
      await child.kill();
    }
  });

  it('refuses to start a second broker over a supervisor-less child', async () => {
    const env = createHome();
    const stateDir = createStateDir();
    const claim = writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      state_dir: stateDir,
      status: 'reserved',
    });
    const child = await spawnHoldingChild(claim, env);

    try {
      await expect(
        acquireNodeClaim({
          nodeId: 'node_1',
          pid: process.pid,
          stateDir: '/checkout-b',
          env,
          execCommand: realExec,
        })
      ).rejects.toBeInstanceOf(NodeClaimConflictError);
    } finally {
      await child.kill();
    }
  });

  it('names the holder through a claims path that needs shell quoting', async () => {
    // `AGENT_RELAY_HOME` is operator input and reaches `lsof` as an argument.
    // A mis-quoted path degrades to "could not be checked", which still reads
    // as held — so the holder's pid, not the verdict, is what proves the
    // command was well formed.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-home-'));
    tmpRoots.push(base);
    const env: NodeJS.ProcessEnv = {
      AGENT_RELAY_HOME: path.join(base, "re'lay home"),
      HOME: base,
      XDG_DATA_HOME: path.join(base, 'data'),
    };
    const claim = writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      state_dir: createStateDir(),
      status: 'reserved',
    });
    const child = await spawnHoldingChild(claim, env);

    try {
      const status = await inspectNodeClaim('node_1', { env, execCommand: realExec });

      expect(status.state === 'held' && status.reason).toContain(String(child.pid));
    } finally {
      await child.kill();
    }
  });

  it('does not let an unrelated process that inherited the descriptor pin the node', async () => {
    // Inherited descriptors are not close-on-exec, so whatever the broker
    // spawns inherits this one too. A harness outliving its broker must not
    // guard a node id no broker is serving — but ruling it out is a positive
    // determination (it is running a different executable than the broker this
    // claim recorded), never a guess about its filename.
    const env = createHome();
    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: await deadPid(),
      stateDir: createStateDir(),
      brokerBinary: '/bin/sh',
      status: 'reserved',
      env,
      execCommand: realExec,
    });
    const child = await spawnHoldingChild(claim, env, { brokerLikeArgv: false });

    try {
      const status = await inspectNodeClaim('node_1', { env, execCommand: realExec });

      expect(status.state).toBe('stale');
    } finally {
      await child.kill();
    }
  });

  it('holds a node whose broker runs under an operator-chosen executable name', async () => {
    // The gap this closes: a broker started from AGENT_RELAY_BIN under any
    // other filename, with the default state dir, carries neither `agent-relay`
    // nor its state dir in argv. Classified by name it read as an unrelated
    // process, so the next start took the node id from a live broker and the
    // engine moved the delivery socket out from under it.
    const env = createHome();
    const binary = createCustomBrokerBinary();
    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: await deadPid(),
      stateDir: createStateDir(),
      brokerBinary: binary,
      status: 'reserved',
      env,
      execCommand: realExec,
    });
    expect(claim.broker_executable).toMatch(/^0x[0-9a-f]+:[1-9][0-9]*$/);
    const child = await spawnHoldingChild(claim, env, { brokerLikeArgv: false, executable: binary });

    try {
      const status = await inspectNodeClaim('node_1', { env, execCommand: realExec });

      expect(status.state).toBe('held');
      expect(status.state === 'held' && status.claim.pid).toBe(child.pid);
      await expect(
        acquireNodeClaim({
          nodeId: 'node_1',
          pid: process.pid,
          stateDir: '/checkout-b',
          env,
          execCommand: realExec,
        })
      ).rejects.toBeInstanceOf(NodeClaimConflictError);
    } finally {
      await child.kill();
    }
  });

  it('finds a published broker running under an operator-chosen executable name', async () => {
    // The same broker one step later: it has written `connection.json`, so the
    // evidence is its own published pid rather than the hold descriptor. That
    // path classified processes by name too.
    const env = createHome();
    const binary = createCustomBrokerBinary();
    const stateDir = createStateDir();
    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: await deadPid(),
      stateDir,
      brokerBinary: binary,
      status: 'reserved',
      env,
      execCommand: realExec,
    });
    const broker = await spawnSleeper(binary);
    writeConnectionFile(claim.state_dir, broker.pid);

    try {
      const status = await inspectNodeClaim('node_1', { env, execCommand: realExec });

      expect(status.state).toBe('held');
      expect(status.state === 'held' && status.claim.pid).toBe(broker.pid);
    } finally {
      await broker.kill();
    }
  });

  it('keeps guarding a claim that records no broker executable at all', async () => {
    // Claims written by an older CLI have nothing to compare a holder against.
    // Unclassifiable is not the same as unrelated: nothing but a Relay start
    // ever passes this descriptor on, and a refusal is recoverable where a
    // wrong "node id free" verdict is a silent delivery outage.
    const env = createHome();
    const claim = writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      state_dir: createStateDir(),
      status: 'reserved',
    });
    const child = await spawnHoldingChild(claim, env, { brokerLikeArgv: false });

    try {
      await expect(inspectNodeClaim('node_1', { env, execCommand: realExec })).resolves.toMatchObject({
        state: 'held',
      });
    } finally {
      await child.kill();
    }
  });

  it('prunes a superseded generation together with its hold file', async () => {
    const env = createHome();
    const first = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      env,
      execCommand: psDeps(),
    });
    closeNodeClaimHold(openNodeClaimHold(first, env));

    const second = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/other/state',
      env,
      force: true,
      execCommand: psDeps(),
    });

    expect(second.generation).toBe(2);
    expect(fs.existsSync(nodeClaimPath('node_1', env, 1))).toBe(false);
    // Left behind, the spent hold file would keep answering for a generation
    // that no longer owns anything.
    expect(fs.existsSync(nodeClaimHoldPath('node_1', env, 1))).toBe(false);
  });

  it('frees the node id as soon as the orphaned child is gone', async () => {
    const env = createHome();
    const stateDir = createStateDir();
    const claim = writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      state_dir: stateDir,
      status: 'reserved',
    });
    const child = await spawnHoldingChild(claim, env);
    await child.kill();

    // The kernel dropped the last reference; nothing is left to guard.
    const status = await inspectNodeClaim('node_1', { env, execCommand: realExec });

    expect(status.state).toBe('stale');
  });

  it('takes the node over cleanly and leaves no hold file behind', async () => {
    const env = createHome();
    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      env,
      execCommand: psDeps(),
    });
    const hold = openNodeClaimHold(claim, env);
    closeNodeClaimHold(hold);
    expect(fs.existsSync(nodeClaimHoldPath('node_1', env, claim.generation ?? 1))).toBe(true);

    await expect(releaseNodeClaim(claim, env)).resolves.toBe(true);

    expect(fs.existsSync(nodeClaimHoldPath('node_1', env, claim.generation ?? 1))).toBe(false);
  });

  it('refuses the start rather than running unfenced when the hold cannot be written', async () => {
    const env = createHome();
    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: await deadPid(),
      stateDir: createStateDir(),
      env,
      execCommand: psDeps(),
    });
    const holdPath = nodeClaimHoldPath('node_1', env, claim.generation ?? 1);
    const write = vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      const error: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device');
      error.code = 'ENOSPC';
      throw error;
    });

    try {
      expect(() => openNodeClaimHold(claim, env)).toThrow(NodeClaimHoldError);
    } finally {
      write.mockRestore();
    }

    // A fence that half-exists is worse than none: the descriptor we opened
    // would keep answering `lsof` for this process's whole life, pinning a node
    // id nothing is actually serving.
    expect(fs.existsSync(holdPath)).toBe(false);
    await expect(inspectNodeClaim('node_1', { env, execCommand: realExec })).resolves.toMatchObject({
      state: 'stale',
    });
  });

  it('refuses rather than reusing a hold file it did not create', async () => {
    const env = createHome();
    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      env,
      execCommand: psDeps(),
    });
    const holdPath = nodeClaimHoldPath('node_1', env, claim.generation ?? 1);
    fs.mkdirSync(path.dirname(holdPath), { recursive: true });
    fs.writeFileSync(holdPath, 'someone else\n');

    expect(() => openNodeClaimHold(claim, env)).toThrow(NodeClaimHoldError);
    // Removing it would drop the fence off whatever is still holding that
    // inode open, so the debris is left exactly as it was found.
    expect(fs.readFileSync(holdPath, 'utf8')).toBe('someone else\n');
  });
});
describe('releaseNodeClaim', () => {
  it('removes a claim it still owns', async () => {
    const env = createHome();
    const claim = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      env,
    });

    await expect(releaseNodeClaim(claim, env)).resolves.toBe(true);
    expect(readNodeClaim('node_1', env)).toBeNull();
  });

  it("leaves a replacement broker's claim alone", async () => {
    const env = createHome();
    const mine: NodeClaim = writeClaim(env, { node_id: 'node_1', pid: 111 }, 1);
    writeClaim(env, { node_id: 'node_1', pid: 222 }, 2);

    // Each acquisition owns exactly one generation file, so releasing ours can
    // never reach the replacement's.
    await releaseNodeClaim(mine, env);
    expect(readNodeClaim('node_1', env)?.pid).toBe(222);
  });

  it('reports nothing released when the claim was already taken over', async () => {
    const env = createHome();
    const mine = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      env,
    });
    // A `--force` start took the node over and cleaned up the generation we own.
    await acquireNodeClaim({
      nodeId: 'node_1',
      pid: 222,
      stateDir: '/other/state',
      env,
      force: true,
    });

    await expect(releaseNodeClaim(mine, env)).resolves.toBe(false);
    expect(readNodeClaim('node_1', env)?.pid).toBe(222);
  });

  it('releases by broker pid and state dir, as `node down` must', async () => {
    const env = createHome();
    const stateDir = createStateDir();
    writeClaim(env, { node_id: 'node_1', pid: 555, state_dir: stateDir });
    writeClaim(env, { node_id: 'node_2', pid: 555, state_dir: '/elsewhere' });
    writeClaim(env, { node_id: 'node_3', pid: 556, state_dir: stateDir });

    const released = await releaseNodeClaimsForBroker({
      pid: 555,
      stateDir,
      env,
      killProcess: () => undefined,
      execCommand: psDeps(),
    });

    expect(released.map((claim) => claim.node_id)).toEqual(['node_1']);
    expect(
      listNodeClaims(env)
        .map((claim) => claim.node_id)
        .sort()
    ).toEqual(['node_2', 'node_3']);
  });

  it('releases an orphaned claim for the state dir it just verified empty', async () => {
    // `node up` was SIGKILLed before it could record its broker's pid, so the
    // claim names only dead pids. `down` has proven that state dir is empty.
    const env = createHome();
    const stateDir = createStateDir();
    writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      state_dir: stateDir,
      status: 'reserved',
    });

    const released = await releaseNodeClaimsForBroker({
      pid: 999_999,
      stateDir,
      env,
      execCommand: psDeps(),
    });

    expect(released.map((claim) => claim.node_id)).toEqual(['node_1']);
  });

  it('keeps a claim another live broker holds in the same state dir', async () => {
    const env = createHome();
    const stateDir = createStateDir();
    writeClaim(env, { node_id: 'node_1', pid: process.pid, state_dir: stateDir });

    const released = await releaseNodeClaimsForBroker({
      pid: 999_999,
      stateDir,
      env,
      execCommand: psDeps(),
    });

    expect(released).toEqual([]);
    expect(readNodeClaim('node_1', env)).not.toBeNull();
  });
});

describe('adoptNodeClaim', () => {
  it('moves a reservation onto the verified broker pid', async () => {
    const env = createHome();
    const reservation = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      status: 'reserved',
      env,
    });

    const adopted = await adoptNodeClaim({
      reservation,
      pid: 909090,
      apiPort: 3891,
      brokerName: 'relay-lead',
      env,
    });

    expect(adopted).toMatchObject({
      pid: 909090,
      status: 'active',
      supervisor_pid: process.pid,
      api_port: 3891,
      broker_name: 'relay-lead',
    });
    expect(readNodeClaim('node_1', env)).toMatchObject({ pid: 909090, status: 'active' });
  });

  it('refuses when the reservation was taken over while the broker started', async () => {
    const env = createHome();
    const reservation = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      status: 'reserved',
      env,
    });
    // A `--force` start landed in the meantime and owns the node id now.
    writeClaim(env, { node_id: 'node_1', pid: 777, state_dir: '/other/state' }, 2);

    await expect(adoptNodeClaim({ reservation, pid: 909090, env })).rejects.toBeInstanceOf(
      NodeClaimConflictError
    );
    // The winner's claim is untouched: two brokers must not both read as owner.
    expect(readNodeClaim('node_1', env)).toMatchObject({ pid: 777 });
  });

  it('refuses when the reservation file was removed under it', async () => {
    const env = createHome();
    const reservation = await acquireNodeClaim({
      nodeId: 'node_1',
      pid: process.pid,
      stateDir: '/repo/state',
      status: 'reserved',
      env,
    });
    fs.unlinkSync(nodeClaimPath('node_1', env, reservation.generation ?? 1));

    await expect(adoptNodeClaim({ reservation, pid: 909090, env })).rejects.toBeInstanceOf(
      NodeClaimConflictError
    );
  });

  it('keeps a claim held when the supervising CLI died but the broker runs on', async () => {
    const env = createHome();
    writeClaim(env, {
      node_id: 'node_1',
      pid: process.pid,
      supervisor_pid: await deadPid(),
      status: 'active',
    });

    // The crash window the two-phase claim exists to cover: a supervisor that
    // dies after its broker registered must not leave that broker unprotected.
    await expect(inspectNodeClaim('node_1', { env })).resolves.toMatchObject({ state: 'held' });
  });

  it('retires a claim only once every process it names is gone', async () => {
    const env = createHome();
    writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      supervisor_pid: await deadPid(),
      status: 'active',
    });

    await expect(inspectNodeClaim('node_1', { env })).resolves.toMatchObject({ state: 'stale' });
  });

  it('keeps a claim held while its supervisor is alive after the broker pid is gone', async () => {
    const env = createHome();
    writeClaim(env, {
      node_id: 'node_1',
      pid: await deadPid(),
      supervisor_pid: process.pid,
      status: 'active',
    });

    const status = await inspectNodeClaim('node_1', { env });

    expect(status.state).toBe('held');
  });
});

describe('enrolledNodeIdForClaim', () => {
  it('guards a node id the environment carries a token for', () => {
    const env = { ...createHome(), RELAY_NODE_ID: 'node_1', RELAY_NODE_TOKEN: 'nt_live_env' };

    expect(enrolledNodeIdForClaim(env)).toBe('node_1');
  });

  it('guards a node id the broker can authenticate from its cached token', () => {
    const env = { ...createHome(), RELAY_NODE_ID: 'node_1' };
    writeCachedNodeToken(env, 'node_1');

    // `resolve_cached_node_token` falls back to this cache when RELAY_NODE_TOKEN
    // is unset, so such a start can still register as (and evict) node_1.
    expect(hasCachedNodeToken('node_1', env)).toBe(true);
    expect(enrolledNodeIdForClaim(env)).toBe('node_1');
  });

  it('ignores a token cached for a different node id', () => {
    const env = { ...createHome(), RELAY_NODE_ID: 'node_1' };
    writeCachedNodeToken(env, 'node_2');

    expect(enrolledNodeIdForClaim(env)).toBeUndefined();
  });

  it('claims nothing for a node id with no credential anywhere', () => {
    const env = { ...createHome(), RELAY_NODE_ID: 'node_1' };

    expect(enrolledNodeIdForClaim(env)).toBeUndefined();
  });

  it('claims nothing without a node id to register as', () => {
    const env = { ...createHome(), RELAY_NODE_TOKEN: 'nt_live_env' };

    expect(enrolledNodeIdForClaim(env)).toBeUndefined();
  });
});

describe('listHeldNodeClaims', () => {
  it('returns only claims backed by a live process', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_live', pid: process.pid, claimed_at: '2026-10-05T12:00:00.000Z' });
    writeClaim(env, { node_id: 'node_dead', pid: await deadPid(), claimed_at: '2026-10-04T12:00:00.000Z' });

    const held = await listHeldNodeClaims({ env });

    expect(held.map((claim) => claim.node_id)).toEqual(['node_live']);
  });

  it('reads an absent claims directory as empty', async () => {
    const env = createHome();
    fs.rmSync(nodeClaimsDir(env), { recursive: true, force: true });

    expect(listNodeClaims(env)).toEqual([]);
    await expect(listHeldNodeClaims({ env })).resolves.toEqual([]);
  });
});

describe('nodeClaimsDir', () => {
  it('sits beside the fleet enrollment store it guards', () => {
    const env = createHome();

    // node-claim.ts resolves AGENT_RELAY_HOME itself rather than importing the
    // Cloud barrel (which drags in the SSH runtime). This pins the two to the
    // same directory so they cannot drift.
    expect(nodeClaimsDir(env)).toBe(
      path.join(path.dirname(fleetNodeEnrollmentStorePath(env)), 'node-claims')
    );
  });
});

describe('nodeClaimPath', () => {
  it('keeps a claim filename inside the claims directory', () => {
    const env = createHome();

    const file = nodeClaimPath('../../escape/node_1', env);

    expect(path.dirname(file)).toBe(nodeClaimsDir(env));
    expect(path.basename(file)).not.toContain('/');
  });
});
