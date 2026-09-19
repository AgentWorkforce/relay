import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fleetNodeEnrollmentStorePath } from '@agent-relay/cloud';

import {
  acquireNodeClaim,
  adoptNodeClaim,
  describeNodeClaimHolder,
  enrolledNodeIdForClaim,
  hasCachedNodeToken,
  inspectNodeClaim,
  listHeldNodeClaims,
  listNodeClaims,
  nodeClaimLockPath,
  nodeClaimPath,
  nodeClaimsDir,
  NodeClaimConflictError,
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

/** Cache a node token where the broker's `resolve_cached_node_token` reads it. */
function writeCachedNodeToken(env: NodeJS.ProcessEnv, nodeId: string): void {
  const file = path.join(env.XDG_DATA_HOME!, 'agent-relay', 'node-tokens', `${nodeId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ node_id: nodeId, workspace_id: 'ws_test', token: 'nt_live_cached' })
  );
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
  claim: Partial<NodeClaim> & { node_id: string; pid: number }
): NodeClaim {
  const full: NodeClaim = {
    version: 1,
    state_dir: '/repo/.agentworkforce/relay',
    claimed_at: '2026-10-05T12:00:00.000Z',
    ...claim,
  };
  const file = nodeClaimPath(full.node_id, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(full, null, 2)}\n`);
  return full;
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
  });

  it('lets the same broker refresh its own claim', async () => {
    const env = createHome();
    writeClaim(env, { node_id: 'node_1', pid: process.pid, state_dir: '/repo/state' });

    await expect(
      acquireNodeClaim({ nodeId: 'node_1', pid: process.pid, stateDir: '/repo/state', env })
    ).resolves.toMatchObject({ pid: process.pid });
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
    const mine: NodeClaim = writeClaim(env, { node_id: 'node_1', pid: 111 });
    writeClaim(env, { node_id: 'node_1', pid: 222 });

    await expect(releaseNodeClaim(mine, env)).resolves.toBe(false);
    expect(readNodeClaim('node_1', env)?.pid).toBe(222);
  });

  it('re-reads the claim under the lock, so a late release spares a replacement', async () => {
    const env = createHome();
    const mine: NodeClaim = writeClaim(env, { node_id: 'node_1', pid: 111 });
    const lock = nodeClaimLockPath('node_1', env);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    // Another CLI is mid-acquisition for this node: fresh lock, live owner.
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), token: 'other' })
    );

    const pending = releaseNodeClaim(mine, env);
    // That acquisition finishes: node_1 now belongs to a different broker.
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeClaim(env, { node_id: 'node_1', pid: 222 });
    fs.unlinkSync(lock);

    // Without the lock this read happened before the replacement landed, and
    // the unlink after it — deleting the new broker's claim and reporting true.
    await expect(pending).resolves.toBe(false);
    expect(readNodeClaim('node_1', env)?.pid).toBe(222);
  });

  it('releases by broker pid and state dir, as `node down` must', async () => {
    const env = createHome();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-state-'));
    tmpRoots.push(stateDir);
    writeClaim(env, { node_id: 'node_1', pid: 555, state_dir: stateDir });
    writeClaim(env, { node_id: 'node_2', pid: 555, state_dir: '/elsewhere' });
    writeClaim(env, { node_id: 'node_3', pid: 556, state_dir: stateDir });

    const released = await releaseNodeClaimsForBroker({ pid: 555, stateDir, env });

    expect(released.map((claim) => claim.node_id)).toEqual(['node_1']);
    expect(
      listNodeClaims(env)
        .map((claim) => claim.node_id)
        .sort()
    ).toEqual(['node_2', 'node_3']);
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

  it('recovers a lock whose holder crashed while holding it', async () => {
    const env = createHome();
    const lock = nodeClaimLockPath('node_1', env);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: await deadPid(),
        acquired_at: new Date(Date.now() - 60_000).toISOString(),
        token: 'crashed-holder',
      })
    );

    await expect(
      acquireNodeClaim({ nodeId: 'node_1', pid: process.pid, stateDir: '/repo/state', env })
    ).resolves.toMatchObject({ pid: process.pid });
    expect(fs.existsSync(lock)).toBe(false);
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
    writeClaim(env, { node_id: 'node_1', pid: 777, state_dir: '/other/state' });

    await expect(adoptNodeClaim({ reservation, pid: 909090, env })).rejects.toBeInstanceOf(
      NodeClaimConflictError
    );
    // The winner's claim is untouched: two brokers must not both read as owner.
    expect(readNodeClaim('node_1', env)).toMatchObject({ pid: 777 });
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
