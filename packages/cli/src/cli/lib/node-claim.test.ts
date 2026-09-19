import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fleetNodeEnrollmentStorePath } from '@agent-relay/cloud';

import {
  acquireNodeClaim,
  describeNodeClaimHolder,
  inspectNodeClaim,
  listHeldNodeClaims,
  listNodeClaims,
  nodeClaimPath,
  nodeClaimsDir,
  NodeClaimConflictError,
  readNodeClaim,
  releaseNodeClaim,
  releaseNodeClaimsForBroker,
  type NodeClaim,
} from './node-claim.js';

const tmpRoots: string[] = [];

/** A scratch `AGENT_RELAY_HOME` so no test reads the developer's real claims. */
function createHome(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-home-'));
  tmpRoots.push(home);
  return { AGENT_RELAY_HOME: home };
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

    expect(releaseNodeClaim(claim, env)).toBe(true);
    expect(readNodeClaim('node_1', env)).toBeNull();
  });

  it("leaves a replacement broker's claim alone", async () => {
    const env = createHome();
    const mine: NodeClaim = writeClaim(env, { node_id: 'node_1', pid: 111 });
    writeClaim(env, { node_id: 'node_1', pid: 222 });

    expect(releaseNodeClaim(mine, env)).toBe(false);
    expect(readNodeClaim('node_1', env)?.pid).toBe(222);
  });

  it('releases by broker pid and state dir, as `node down` must', () => {
    const env = createHome();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-state-'));
    tmpRoots.push(stateDir);
    writeClaim(env, { node_id: 'node_1', pid: 555, state_dir: stateDir });
    writeClaim(env, { node_id: 'node_2', pid: 555, state_dir: '/elsewhere' });
    writeClaim(env, { node_id: 'node_3', pid: 556, state_dir: stateDir });

    const released = releaseNodeClaimsForBroker({ pid: 555, stateDir, env });

    expect(released.map((claim) => claim.node_id)).toEqual(['node_1']);
    expect(
      listNodeClaims(env)
        .map((claim) => claim.node_id)
        .sort()
    ).toEqual(['node_2', 'node_3']);
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
