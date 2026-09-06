import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentStream,
  CLOUD_ENROLLED_NODE_FILE,
  cleanupTmp,
  createTrigger,
  createWorkspace,
  delay,
  enrollNode,
  FleetNode,
  getAgent,
  getFreePort,
  getInvocation,
  getNodes,
  invokeAction,
  invokeNodeAction,
  joinChannel,
  listDeliveries,
  listMessages,
  makeTmpRoot,
  mintObserverToken,
  ObserverStream,
  NODE_A_FILE,
  NODE_B_FILE,
  postMessage,
  preflight,
  registerAgent,
  releaseAgent,
  REPO_ROOT,
  sendDm,
  startCloudEnrollmentEndpoint,
  startEngine,
  waitFor,
  type EngineHandle,
  type NodeRosterEntry,
} from './harness.js';

const require = createRequire(import.meta.url);
const { RELEASE_PROBE_PID_FILE } = require('./nodes/release-probe-constants.cjs') as {
  RELEASE_PROBE_PID_FILE: string;
};

/**
 * Two-node fleet E2E (Phase 6). Boots a REAL stack — a relaycast engine (node
 * adapter), two `agent-relay node up` nodes each with their own Rust broker
 * + TS sidecar — and drives the scenario matrix over the live control wire.
 *
 * Skips cleanly (never fails) when prerequisites are absent.
 */
const pre = preflight();
if (!pre.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[fleet-e2e] skipped: ${pre.reason}`);
}

describe.skipIf(!pre.ok)('Cloud-enrolled node startup', () => {
  let tmpRoot: string;
  let engine: EngineHandle;
  let workspaceKey: string;
  let enrolledNode: FleetNode;

  beforeAll(async () => {
    tmpRoot = makeTmpRoot();
    engine = await startEngine(pre.engineServe!, tmpRoot);
    workspaceKey = await createWorkspace(engine, 'cloud-enrollment-e2e');

    const nodeId = 'node_cloud_enrolled';
    const nodeName = 'cloud-enrolled';
    const nodeToken = await enrollNode(engine, workspaceKey, nodeId, nodeName, ['cloud:ping']);
    const enrollmentToken = 'ocl_node_enr_e2e_once';
    const endpoint = await startCloudEnrollmentEndpoint({
      enrollmentToken,
      nodeId,
      nodeName,
      nodeToken,
      relayWorkspaceId: 'fleet-e2e',
      relaycastUrl: engine.baseUrl,
    });

    enrolledNode = new FleetNode({
      name: nodeName,
      nodeId,
      nodeFile: CLOUD_ENROLLED_NODE_FILE,
      nodeToken,
      workspaceKey,
      engineBaseUrl: engine.baseUrl,
      brokerBinary: pre.brokerBinary!,
      tmpRoot,
      capacityHarnesses: 'claude',
      usePersistedEnrollment: true,
    });
    try {
      await enrolledNode.cloudEnroll(endpoint.url, enrollmentToken);
    } finally {
      await endpoint.stop();
    }
    enrolledNode.start();
  }, 45_000);

  afterAll(async () => {
    await enrolledNode?.stop();
    await engine?.stop();
    if (tmpRoot && !process.env.CI) cleanupTmp(tmpRoot);
  });

  it('enroll -> node up presents the enrolled id and registers its capabilities and tags', async () => {
    const enrolled = await waitFor(
      async () => {
        const nodes = await getNodes(engine, workspaceKey, { name: 'cloud-enrolled' });
        const match = nodes.find((node) => node.id === 'node_cloud_enrolled');
        // The broker provider is independently ready for spawn/release before
        // the config-backed action provider finishes registering.
        return match?.live &&
          match.handlers_live &&
          match.capabilities.some((capability) => capability.name === 'cloud:ping') &&
          match.tags?.includes('cloud-enrolled') &&
          match.tags.includes('e2e')
          ? match
          : null;
      },
      { timeoutMs: 30_000, label: 'Cloud-enrolled node online with broker and action handlers' }
    );

    expect(enrolled.name).toBe('cloud-enrolled');
    expect(enrolled.capabilities.map((capability) => capability.name)).toContain('cloud:ping');
    expect(enrolled.tags).toEqual(expect.arrayContaining(['cloud-enrolled', 'e2e']));
  });
});

async function pollUntilStable<T>(
  read: () => Promise<T>,
  key: (v: T) => string,
  opts: { stableFor?: number; intervalMs?: number; maxMs?: number } = {}
): Promise<T> {
  const stableFor = opts.stableFor ?? 3;
  const intervalMs = opts.intervalMs ?? 300;
  const maxMs = opts.maxMs ?? 8_000;
  const deadline = Date.now() + maxMs;
  let last = await read();
  let lastKey = key(last);
  let stable = 0;
  while (Date.now() < deadline && stable < stableFor) {
    await delay(intervalMs);
    const next = await read();
    const nextKey = key(next);
    if (nextKey === lastKey) stable += 1;
    else {
      stable = 0;
      lastKey = nextKey;
    }
    last = next;
  }
  return last;
}

describe.skipIf(!pre.ok)('two-node fleet scenario matrix', () => {
  let tmpRoot: string;
  let engine: EngineHandle;
  let workspaceKey: string;
  let driverToken: string;
  let nodeA: FleetNode;
  let nodeB: FleetNode;

  const node = (nodes: NodeRosterEntry[], name: string) => nodes.find((n) => n.name === name);

  beforeAll(async () => {
    tmpRoot = makeTmpRoot();
    engine = await startEngine(pre.engineServe!, tmpRoot);
    workspaceKey = await createWorkspace(engine, 'fleet-e2e');

    const tokenA = await enrollNode(engine, workspaceKey, 'node_a', 'node-a', [
      'spawn:claude',
      'spawn:pool',
      'echo',
      'work',
    ]);
    const tokenB = await enrollNode(engine, workspaceKey, 'node_b', 'node-b', [
      'spawn:codex',
      'spawn:pool',
      'ping',
      'work',
    ]);

    nodeA = new FleetNode({
      name: 'node-a',
      nodeId: 'node_a',
      nodeFile: NODE_A_FILE,
      nodeToken: tokenA,
      workspaceKey,
      engineBaseUrl: engine.baseUrl,
      brokerBinary: pre.brokerBinary!,
      tmpRoot,
      // Pin capacity so the node advertises a distinct harness (`claude`) plus the
      // shared `pool`. A `spawn:<harness>` shadow delegates to the broker's native
      // capacity for that harness, so every shadow the node defines (spawn:claude,
      // spawn:pool, spawn:release-probe) needs matching broker capacity — otherwise
      // the delegation has nothing to run.
      capacityHarnesses: 'claude,pool,release-probe',
    });
    nodeB = new FleetNode({
      name: 'node-b',
      nodeId: 'node_b',
      nodeFile: NODE_B_FILE,
      nodeToken: tokenB,
      workspaceKey,
      engineBaseUrl: engine.baseUrl,
      brokerBinary: pre.brokerBinary!,
      tmpRoot,
      // Distinct `codex` plus the shared `pool` (see node-a's note).
      capacityHarnesses: 'codex,pool',
    });
    nodeA.start();
    nodeB.start();

    driverToken = await registerAgent(engine, workspaceKey, 'driver');

    await waitFor(
      async () => {
        const nodes = await getNodes(engine, workspaceKey);
        const a = node(nodes, 'node-a');
        const b = node(nodes, 'node-b');
        const aCapabilities = new Set(a?.capabilities.map((capability) => capability.name));
        const bCapabilities = new Set(b?.capabilities.map((capability) => capability.name));
        // handlers_live covers the broker provider too, so wait for the
        // separately connected action providers before asserting their union.
        return a?.live &&
          a.handlers_live &&
          aCapabilities.has('echo') &&
          aCapabilities.has('work') &&
          b?.live &&
          b.handlers_live &&
          bCapabilities.has('ping') &&
          bCapabilities.has('work')
          ? nodes
          : null;
      },
      { timeoutMs: 45_000, label: 'both nodes online with broker and action handlers' }
    );
  }, 60_000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    await engine?.stop();
    // Keep tmp (incl. serve.log) in CI so the log-upload step can attach it.
    if (tmpRoot && !process.env.CI) cleanupTmp(tmpRoot);
  });

  it('boot/register: both nodes online with the right capability objects (real broker Bearer auth)', async () => {
    const nodes = await getNodes(engine, workspaceKey);
    const a = node(nodes, 'node-a')!;
    const b = node(nodes, 'node-b')!;
    expect(a.live).toBe(true);
    expect(a.handlers_live).toBe(true);
    expect(b.handlers_live).toBe(true);
    // The aggregate is the union of the broker provider's capacity (its pinned
    // spawn:<harness> + release, plus the relay:delivery-cursor-v1 marker it
    // advertises for restart-safe mailbox resume and the relay:live-agents:v1
    // heartbeat snapshot) and the fleet provider's action capabilities.
    expect(a.capabilities.map((c) => c.name).sort()).toEqual([
      'echo',
      'relay:delivery-cursor-v1',
      'relay:live-agents:v1',
      'release',
      'spawn:claude',
      'spawn:pool',
      'spawn:release-probe',
      'work',
    ]);
    expect(b.capabilities.map((c) => c.name).sort()).toEqual([
      'ping',
      'relay:delivery-cursor-v1',
      'relay:live-agents:v1',
      'release',
      'spawn:codex',
      'spawn:pool',
      'work',
    ]);
    expect(a.capabilities.find((c) => c.name === 'relay:live-agents:v1')?.metadata).toEqual({
      names: [],
    });
    expect(b.capabilities.find((c) => c.name === 'relay:live-agents:v1')?.metadata).toEqual({
      names: [],
    });
  });

  it('negative auth: a node whose broker presents a bogus token never comes online', async () => {
    // Enrolled (valid roster row) but the broker is handed a wrong token, so the
    // node_control Bearer handshake is rejected → never reaches handlers_live.
    // Guards against a regression that disables node-auth enforcement. The node
    // definition file is irrelevant here (the broker never authenticates, so the
    // manifest is never sent) — any valid fleet node file works.
    await enrollNode(engine, workspaceKey, 'node_c', 'node-c', ['work']);
    const badNode = new FleetNode({
      name: 'node-c',
      nodeId: 'node_c',
      nodeFile: NODE_B_FILE,
      nodeToken: 'nt_live_bogustoken0000000000000000',
      // No workspace key: with one, the broker would re-mint a valid node token on
      // the 401 (self-heal) and come online. Withholding it makes the bogus token
      // fatal, which is what this test guards.
      workspaceKey: '',
      engineBaseUrl: engine.baseUrl,
      brokerBinary: pre.brokerBinary!,
      tmpRoot,
    });
    badNode.start();
    try {
      // Valid nodes reach handlers_live in ~2–4s (see beforeAll); poll for 5s and
      // assert node-c stays offline the WHOLE time — a single late check could
      // miss a (buggy) delayed bring-up, so we require it never flips live.
      for (let i = 0; i < 10; i++) {
        const c = node(await getNodes(engine, workspaceKey), 'node-c');
        expect(c?.handlers_live ?? false).toBe(false);
        expect(c?.live ?? false).toBe(false);
        await delay(500);
      }
    } finally {
      await badNode.stop();
    }
  }, 30_000);

  it('capability query: roster filtered by capability returns the right node(s)', async () => {
    expect((await getNodes(engine, workspaceKey, { capability: 'echo' })).map((n) => n.name)).toEqual([
      'node-a',
    ]);
    expect((await getNodes(engine, workspaceKey, { capability: 'spawn:codex' })).map((n) => n.name)).toEqual([
      'node-b',
    ]);
    // spawn:pool is shared — both nodes answer.
    expect(
      (await getNodes(engine, workspaceKey, { capability: 'spawn:pool' })).map((n) => n.name).sort()
    ).toEqual(['node-a', 'node-b']);
  });

  it('public fleet release proves process, node heartbeat, and engine roster absence', async () => {
    const name = `release-1671-${Date.now().toString(36)}`;
    const spawned = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'release-probe',
      name,
      target_node: 'node-a',
    });
    expect(spawned.status).toBe(201);
    const spawnDone = await waitFor(
      async () => {
        const invocation = await getInvocation(engine, driverToken, 'spawn', spawned.invocationId!);
        return invocation.status === 'completed' || invocation.status === 'failed' ? invocation : null;
      },
      { timeoutMs: 30_000, label: 'release probe spawn settled' }
    );
    expect(spawnDone.status).toBe('completed');

    const pidPath = path.join(nodeA.projectDir, '.agentworkforce', 'relay', RELEASE_PROBE_PID_FILE);
    const readDescendant = async (previousToken?: string) => {
      const probe = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid?: number; token?: string };
      expect(Number.isInteger(probe.pid) && probe.pid > 0).toBe(true);
      expect(typeof probe.token === 'string' && probe.token.length > 0).toBe(true);
      return previousToken === undefined || probe.token !== previousToken ? probe : null;
    };
    const descendant = await waitFor(readDescendant, {
      timeoutMs: 10_000,
      label: 'release probe descendant pid',
    });
    const descendantPid = descendant.pid!;

    const cli = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli', 'index.js');
    const released = await runFleetRelease(cli, name, workspaceKey, engine.baseUrl);
    expect(released.status).toBe(0);
    expect(released.stdout).toContain(name);

    const assertReleaseAbsence = async (pid: number, label: string) => {
      await waitFor(
        async () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'
              ? true
              : null;
          }
        },
        { timeoutMs: 12_000, intervalMs: 200, label: `${label}: descendant absent` }
      );

      await waitFor(
        async () => {
          const agent = await getAgent(engine, workspaceKey, name);
          return agent &&
            (agent.status === 'offline' || agent.status === 'released') &&
            !agent.location_node_id
            ? agent
            : null;
        },
        { timeoutMs: 20_000, label: `${label}: engine roster terminal absence` }
      );
      await waitFor(
        async () => {
          const nodeEntry = (await getNodes(engine, workspaceKey, { name: 'node-a' }))[0];
          const live = nodeEntry?.capabilities.find(
            (capability) => capability.name === 'relay:live-agents:v1'
          );
          const names =
            live?.metadata && typeof live.metadata === 'object' && Array.isArray(live.metadata.names)
              ? live.metadata.names
              : [];
          return !names.includes(name) ? nodeEntry : null;
        },
        { timeoutMs: 20_000, label: `${label}: node heartbeat absence` }
      );
    };

    await assertReleaseAbsence(descendantPid, 'first release');

    // A release is idempotent and frees the name: spawn the same name again,
    // then release it through the same public CLI path and prove the second
    // terminal state too.
    const respawned = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'release-probe',
      name,
      target_node: 'node-a',
    });
    expect(respawned.status).toBe(201);
    const respawnDone = await waitFor(
      async () => {
        const invocation = await getInvocation(engine, driverToken, 'spawn', respawned.invocationId!);
        return invocation.status === 'completed' || invocation.status === 'failed' ? invocation : null;
      },
      { timeoutMs: 30_000, label: 'same-name respawn settled' }
    );
    expect(respawnDone.status).toBe('completed');
    const secondDescendant = await waitFor(() => readDescendant(descendant.token), {
      timeoutMs: 10_000,
      label: 'same-name respawn descendant pid',
    });
    const secondDescendantPid = secondDescendant.pid!;
    expect(secondDescendant.token).not.toBe(descendant.token);
    const releasedAgain = await runFleetRelease(cli, name, workspaceKey, engine.baseUrl);
    expect(releasedAgain.status).toBe(0);
    expect(releasedAgain.stdout).toContain(name);
    await assertReleaseAbsence(secondDescendantPid, 'second release');
    const repeatedRelease = await runFleetRelease(cli, name, workspaceKey, engine.baseUrl);
    expect(repeatedRelease.status).toBe(0);
    expect(repeatedRelease.stdout).toContain(name);
    await assertReleaseAbsence(secondDescendantPid, 'idempotent repeated release');
  }, 90_000);

  it('cross-node dispatch: a node-native action runs on its owning node and acks the result', async () => {
    // Fleet-provider actions are node-scoped, so they are invoked on their owning node.
    const echo = await invokeNodeAction(engine, driverToken, 'node-a', 'echo', { text: 'hello-a' });
    expect(echo.status).toBe(201);
    expect(echo.body.data.handler_node_id).toBe('node_a');
    const echoDone = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'echo', echo.invocationId!);
        return inv.status === 'completed' ? inv : null;
      },
      { label: 'echo completed' }
    );
    expect(echoDone.output).toMatchObject({ echoed: 'hello-a', node: 'node-a' });

    const ping = await invokeNodeAction(engine, driverToken, 'node-b', 'ping', { nonce: 'xyz' });
    expect(ping.status).toBe(201);
    const pingDone = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'ping', ping.invocationId!);
        return inv.status === 'completed' ? inv : null;
      },
      { label: 'ping completed' }
    );
    expect(pingDone.output).toMatchObject({ pong: 'xyz', node: 'node-b' });
  });

  it('declarative trigger: a matching channel message fires the action exactly once (loop guard holds)', async () => {
    // Runs before the spawn scenarios: a node that has spawned agents stops
    // posting its own messages (a broker quirk noted for follow-up), and this
    // scenario observes the trigger via the node's echo emission.
    //
    // Bind #general /deploy/ -> echo (node-a). Registered via the engine trigger
    // API because the sidecar's node-file trigger auto-sync is not yet wired.
    await createTrigger(engine, workspaceKey, { channel: 'general', pattern: 'deploy', action_name: 'echo' });
    await joinChannel(engine, driverToken, 'general'); // member, so it can list #general
    // Count ALL `echo:`-prefixed messages. A broken loop guard re-fires on the
    // action's own `echo:please deploy now` (it contains "deploy"), cascading to
    // `echo:echo:...` — DISTINCT strings, so the total of the `echo:` prefix grows
    // beyond before+1. Counting the prefix (not the exact string) is what makes
    // this actually catch a runaway.
    const echoCount = async () =>
      (await listMessages(engine, driverToken, 'general')).filter((m) => m.text?.startsWith('echo:')).length;
    const before = await echoCount();

    expect(await postMessage(engine, driverToken, 'general', 'please deploy now')).toBe(201);
    await waitFor(async () => (await echoCount()) > before, {
      label: 'trigger fired echo',
      timeoutMs: 15_000,
    });

    // Poll until the count is STABLE, then assert exactly one new echo message
    // (the loop guard held — the action-generated reply did not re-trigger).
    const settled = await pollUntilStable(echoCount, (n) => String(n), { stableFor: 5, maxMs: 8_000 });
    expect(settled).toBe(before + 1);
  }, 30_000);

  it('spawn completes end-to-end: targeted spawn delivers its brief after harness readiness and the agent acts', async () => {
    // Five consecutive spawns across both nodes prove this is not a lucky
    // one-off. Node A's stub delays readiness past the historical 25s fallback
    // and discards pre-ready input; node B provides the fast-ready control.
    const cases = [
      { agent: 'worker-a', cli: 'claude', nodeName: 'node-a', nodeId: 'node_a', host: nodeA },
      { agent: 'worker-b1', cli: 'codex', nodeName: 'node-b', nodeId: 'node_b', host: nodeB },
      { agent: 'worker-a2', cli: 'claude', nodeName: 'node-a', nodeId: 'node_a', host: nodeA },
      { agent: 'worker-b2', cli: 'codex', nodeName: 'node-b', nodeId: 'node_b', host: nodeB },
      { agent: 'worker-a3', cli: 'claude', nodeName: 'node-a', nodeId: 'node_a', host: nodeA },
    ] as const;
    const before = new Map(
      (await getNodes(engine, workspaceKey)).map((entry) => [entry.name, entry.active_agents])
    );

    for (const [index, testCase] of cases.entries()) {
      const nonce = `spawn-brief-${index + 1}-${Date.now().toString(36)}`;
      const observationPath = path.join(
        testCase.host.projectDir,
        '.agentworkforce',
        'relay',
        'e2e-brief-actions',
        `${nonce}.json`
      );
      const spawn = await invokeAction(engine, driverToken, 'spawn', {
        cli: testCase.cli,
        name: testCase.agent,
        target_node: testCase.nodeName,
        task: `First, act on this brief by recording RELAY_E2E_BRIEF_NONCE=${nonce}`,
      });
      expect(spawn.status).toBe(201);
      expect(spawn.body.data.handler_node_id).toBe(testCase.nodeId);

      const done = await waitFor(
        async () => {
          const invocation = await getInvocation(engine, driverToken, 'spawn', spawn.invocationId!);
          return invocation.status === 'completed' || invocation.status === 'failed' ? invocation : null;
        },
        { label: `${testCase.agent} spawn settled`, timeoutMs: 35_000 }
      );
      expect(done.status).toBe('completed');

      // Registration and heartbeat only prove that a process exists. The nonce
      // file is written by the PTY child from the injected task, so it proves
      // the brief crossed the harness readiness boundary and caused action.
      const observation = await waitFor(
        async () => {
          try {
            return JSON.parse(readFileSync(observationPath, 'utf8')) as {
              nonce: string;
              agent: string;
              node: string;
              observedAt: string;
            };
          } catch {
            return null;
          }
        },
        { label: `${testCase.agent} acted on nonce-bearing brief`, timeoutMs: 40_000 }
      );
      expect(observation).toMatchObject({
        nonce,
        agent: testCase.agent,
        node: testCase.nodeName,
      });
      expect(Number.isNaN(Date.parse(observation.observedAt))).toBe(false);
    }

    await waitFor(
      async () => {
        const nodes = await getNodes(engine, workspaceKey);
        const a = node(nodes, 'node-a');
        const b = node(nodes, 'node-b');
        return a &&
          b &&
          a.active_agents >= (before.get('node-a') ?? 0) + 3 &&
          b.active_agents >= (before.get('node-b') ?? 0) + 2
          ? { a, b }
          : null;
      },
      { label: 'both nodes heartbeat all five spawned agents', timeoutMs: 20_000 }
    );
  }, 150_000);

  it('capability-routed spawn: with no target, placement picks the only node advertising the capability', async () => {
    const spawn = await invokeAction(engine, driverToken, 'spawn', { cli: 'codex', name: 'worker-codex' });
    expect(spawn.status).toBe(201);
    expect(spawn.body.data.handler_node_id).toBe('node_b');
    const done = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'spawn', spawn.invocationId!);
        return inv.status === 'completed' || inv.status === 'failed' ? inv : null;
      },
      { label: 'codex spawn settled', timeoutMs: 20_000 }
    );
    expect(done.status).toBe('completed');
  }, 30_000);

  it('scheduled spawn: a shared capability routes to the least-loaded node', async () => {
    // Pre-load node-a with a pooled agent, wait for its post-spawn heartbeat to
    // raise active_agents, then a scheduled (untargeted) spawn must pick node-b.
    const pre1 = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'pool',
      name: 'pool-a',
      target_node: 'node-a',
    });
    await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'spawn', pre1.invocationId!);
        return inv.status === 'completed' ? inv : null;
      },
      { label: 'pool-a spawn settled', timeoutMs: 20_000 }
    );

    const loaded = await waitFor(
      async () => {
        const nodes = await getNodes(engine, workspaceKey);
        const a = node(nodes, 'node-a')!;
        const b = node(nodes, 'node-b')!;
        return a.active_agents > b.active_agents ? { a: a.active_agents, b: b.active_agents } : null;
      },
      { label: 'node-a load exceeds node-b', timeoutMs: 20_000 }
    );
    expect(loaded.a).toBeGreaterThan(loaded.b);

    const scheduled = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'pool',
      name: 'pool-scheduled',
    });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.data.handler_node_id).toBe('node_b'); // least-loaded
  }, 60_000);

  // This is the 7th scenario in the serial chain — by now both nodes are running
  // several stub PTY children from the earlier spawn scenarios, so the broker +
  // sidecar are under real contention and the FIRST (untargeted) spawn's settle
  // can occasionally exceed a tight deadline (observed `last=null` ⇒ the
  // invocation simply hadn't reached a terminal status yet, not a logic fault).
  // The origin-rebind correctness (the actual subject of this test, asserted on
  // the resume response below) is unaffected — so we give the settle a realistic
  // deadline and a bounded retry rather than weakening any assertion. The retry
  // re-runs the whole body, so we first release any `resumable-1` left bound by a
  // prior timed-out attempt (the release at the end is skipped when settle throws)
  // to keep each attempt starting from a clean slate.
  it(
    'resume: a resumable spawn re-binds to the agent ORIGIN node (not an arbitrary target)',
    { retry: 2 },
    async () => {
      const sessionRef = 'sess-resume-1';
      await releaseAgent(engine, workspaceKey, 'resumable-1'); // idempotent cleanup for retries
      // First spawn is UNTARGETED → the engine picks the origin node by placement.
      // We capture wherever it actually landed so the resume target is derived from
      // the agent's real origin, not hard-coded (resume = targeted-origin spawn;
      // the engine records origin_node_id but does not auto-route from session_ref).
      const first = await invokeAction(engine, driverToken, 'spawn', {
        cli: 'pool',
        name: 'resumable-1',
        session_ref: sessionRef,
      });
      const originId = first.body.data.handler_node_id as string; // engine-chosen origin
      const originName = originId === 'node_a' ? 'node-a' : 'node-b';
      const firstDone = await waitFor(
        async () => {
          const inv = await getInvocation(engine, driverToken, 'spawn', first.invocationId!);
          return inv.status === 'completed' || inv.status === 'failed' ? inv : null;
        },
        { label: 'resumable spawn settled', timeoutMs: 30_000, intervalMs: 300 }
      );
      expect(firstDone.status).toBe('completed'); // resumable spawn carried session_ref through token authority

      // Release, then resume the SAME session targeted at the recorded origin.
      expect(await releaseAgent(engine, workspaceKey, 'resumable-1')).toBeLessThan(300);
      const resume = await invokeAction(engine, driverToken, 'spawn', {
        cli: 'pool',
        name: 'resumable-1',
        target_node: originName,
        session_ref: sessionRef,
      });
      expect(resume.status).toBe(201);
      expect(resume.body.data.handler_node_id).toBe(originId); // resumed on the agent's origin node
      expect(resume.body.data.dispatched_node_id).toBe(originId);
    },
    60_000
  );

  it('placement failure: spawning a capability no targeted node advertises fails with capability_mismatch', async () => {
    const res = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'claude',
      name: 'worker-x',
      target_node: 'node-b',
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('capability_mismatch');
  });

  it('reschedule on death + restart reconcile: an in-flight invocation reruns elsewhere; the node rejoins and dispatch stays idempotent', async () => {
    // `work` is a node-scoped action on BOTH nodes, so it is node-addressed. Send
    // it to node-a, then kill node-a mid-flight; the engine reschedules the SAME
    // invocation onto the other node that also advertises `work`.
    const work = await invokeNodeAction(engine, driverToken, 'node-a', 'work', {
      nonce: 'resched-1',
      delayMs: 6_000,
    });
    const homeId = work.body.data.handler_node_id as string; // 'node_a'
    const homeName = homeId === 'node_a' ? 'node-a' : 'node-b';
    const otherName = homeName === 'node-a' ? 'node-b' : 'node-a';
    const homeNode = homeName === 'node-a' ? nodeA : nodeB;
    await delay(1_000); // ensure it's dispatched + running on the home node

    await homeNode.stop(); // node host dies mid-invocation

    // (a) reschedule: the SAME invocation reruns on the other eligible node.
    const done = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'work', work.invocationId!);
        return inv.status === 'completed' || inv.status === 'failed' ? inv : null;
      },
      { label: 'work rescheduled + completed', timeoutMs: 40_000 }
    );
    expect(done.status).toBe('completed');
    expect(done.output).toMatchObject({ worked: 'resched-1', node: otherName });

    // (b) handlers_live drops on the dead node.
    await waitFor(
      async () => {
        const h = node(await getNodes(engine, workspaceKey), homeName);
        return h && h.handlers_live === false ? h : null;
      },
      { timeoutMs: 30_000, label: `${homeName} handlers_live false after crash` }
    );

    // (c) restart → inventory.sync reconcile → handlers_live restored.
    homeNode.start();
    await waitFor(
      async () => {
        const h = node(await getNodes(engine, workspaceKey), homeName);
        return h?.live && h.handlers_live ? h : null;
      },
      { timeoutMs: 45_000, label: `${homeName} back online after restart` }
    );

    // (d) the rescheduled invocation is NOT re-claimed by the restarted node. A
    // re-claim would re-dispatch `work` (delayMs 6s) on the restarted node and
    // overwrite the result on completion — so we must watch PAST that window
    // (8s > 6s) and assert the result stays on the rescheduling node the whole time.
    for (let i = 0; i < 16; i++) {
      const post = await getInvocation(engine, driverToken, 'work', work.invocationId!);
      expect(post.status).toBe('completed');
      expect(post.output).toMatchObject({ worked: 'resched-1', node: otherName });
      await delay(500);
    }

    // (e) dispatch works again on the restored node. `ping` is node-scoped to
    // node-b, so it is node-addressed.
    const ping = await invokeNodeAction(engine, driverToken, 'node-b', 'ping', { nonce: 'after-restart' });
    const pingDone = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'ping', ping.invocationId!);
        return inv.status === 'completed' ? inv : null;
      },
      { label: 'ping after restart', timeoutMs: 20_000 }
    );
    expect(pingDone.output).toMatchObject({ pong: 'after-restart', node: 'node-b' });
  }, 120_000);

  it('delivery seq/dedup: an offline agent replays its queued DMs exactly once, in order, on reconnect', async () => {
    // Exactly-once ordered delivery through the real SDK consumer path (AgentClient
    // over the node transport): the same guarantee the node-restart reconcile relies
    // on. DMs sent while the recipient is disconnected QUEUE per-agent and redeliver
    // once, in order, when it reconnects — no over-delivery (replaying acked history)
    // and no under-delivery (replaying nothing). The wire-level resync cursor itself
    // is covered by the relaycast engine's delivery conformance matrix (§8).
    const recipientToken = await registerAgent(engine, workspaceKey, 'seq-rx');
    const rx = new AgentStream(engine.baseUrl, recipientToken);
    await rx.connect();

    // Two DMs delivered live to the connected recipient.
    expect((await sendDm(engine, driverToken, 'seq-rx', 'seq-0')).status).toBeLessThan(300);
    expect((await sendDm(engine, driverToken, 'seq-rx', 'seq-1')).status).toBeLessThan(300);
    await waitFor(async () => rx.texts().length >= 2, { label: 'live DMs delivered' });

    // Disconnect, send two more while offline (they queue), then reconnect.
    await rx.disconnect();
    expect((await sendDm(engine, driverToken, 'seq-rx', 'seq-2')).status).toBeLessThan(300);
    expect((await sendDm(engine, driverToken, 'seq-rx', 'seq-3')).status).toBeLessThan(300);
    await rx.connect();
    await waitFor(async () => rx.texts().length >= 4, { label: 'queued DMs redelivered' });
    await delay(1_000); // settle so any over-delivery surfaces before asserting

    // Every DM exactly once, in order — the reconnect replay neither drops nor duplicates.
    expect(rx.texts()).toEqual(['seq-0', 'seq-1', 'seq-2', 'seq-3']);

    await rx.disconnect();
  }, 30_000);

  // The feature this PR exists for, asserted against a live engine rather than
  // a mock. It is deliberately an e2e: the declared fields do NOT ride the
  // `agent.register` frame (the engine parses that one with a strict schema that
  // rejects unknown keys), they are published over the HTTP agent API on a
  // separate task once registration succeeds. Only a real engine proves that the
  // chosen transport is one the engine actually accepts.
  it('declared workforce metadata reaches the engine as agent metadata', async () => {
    const agent = 'worker-declared-metadata';
    const spawn = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'codex',
      name: agent,
      target_node: 'node-b',
      task: 'ack and wait',
      organization: 'Agent Workforce',
      project: 'Relay',
      workstream: 'fleet-metadata',
      role: 'implementer',
    });
    expect(spawn.status).toBe(201);
    const settled = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'spawn', spawn.invocationId!);
        return inv.status === 'completed' || inv.status === 'failed' ? inv : null;
      },
      { label: 'declared-metadata spawn settled', timeoutMs: 35_000 }
    );
    expect(settled.status).toBe('completed');

    // Snapshot whatever the engine already owns on this record, so the merge
    // assertion below is against real engine-owned keys rather than a guess at
    // which ones exist.
    const before = (await getAgent(engine, workspaceKey, agent))?.metadata ?? {};

    // Poll rather than read once: the publish is intentionally detached from the
    // spawn so it cannot extend the broker's inline registration await.
    const metadata = await waitFor(
      async () => {
        const record = await getAgent(engine, workspaceKey, agent);
        return record?.metadata?.organization ? record.metadata : null;
      },
      { label: 'declared metadata published to the engine', timeoutMs: 20_000 }
    );

    // The publish sends ONLY the declared keys and relies on the engine to merge
    // them over what it already holds. Assert that reliance against the real
    // engine: nothing it owned before the publish may be lost.
    for (const [key, value] of Object.entries(before)) {
      expect(metadata).toHaveProperty(key);
      expect(metadata![key]).toEqual(value);
    }

    expect(metadata).toMatchObject({
      organization: 'Agent Workforce',
      project: 'Relay',
      workstream: 'fleet-metadata',
      role: 'implementer',
      // No explicit objective was declared, so it falls back to the task.
      objective: 'ack and wait',
    });
  }, 70_000);

  // Control for the test above: a spawn that declares nothing must not acquire
  // declared fields from anywhere — no name-derived hierarchy, no leakage from
  // the previous spawn's publish.
  it('a spawn that declares nothing gets no declared metadata', async () => {
    const agent = 'worker-undeclared-metadata';
    const spawn = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'codex',
      name: agent,
      target_node: 'node-b',
    });
    expect(spawn.status).toBe(201);
    const settled = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'spawn', spawn.invocationId!);
        return inv.status === 'completed' || inv.status === 'failed' ? inv : null;
      },
      { label: 'undeclared spawn settled', timeoutMs: 35_000 }
    );
    // A control arm that accepts a FAILED spawn proves nothing: no agent was
    // stamped because none was started.
    expect(settled.status).toBe('completed');

    const initial = await waitFor(async () => await getAgent(engine, workspaceKey, agent), {
      label: 'undeclared agent visible',
      timeoutMs: 20_000,
    });
    // Give any (incorrect) publish the same window the positive test relies on.
    await delay(3_000);
    const final = await getAgent(engine, workspaceKey, agent);
    // Assert against the FINAL read, and require it to exist — falling back to
    // the earlier snapshot would let a broken final read pass this test on
    // stale data.
    expect(final).not.toBeNull();
    for (const key of ['organization', 'project', 'workstream', 'role', 'objective']) {
      expect(initial.metadata ?? {}).not.toHaveProperty(key);
      expect(final!.metadata ?? {}).not.toHaveProperty(key);
    }
  }, 70_000);
});

function runFleetRelease(
  cli: string,
  name: string,
  workspaceKey: string,
  baseUrl: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, 'fleet', 'release', name, '--workspace-key', workspaceKey, '--base-url', baseUrl],
      {
        env: { ...process.env, AGENT_RELAY_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * Bounded durable mailbox (§8) — TTL dead-letter + overflow. These exercise the
 * same mailbox the via-node delivery path uses, driven through a controllable
 * recipient agent (so its delivery ledger is observable) against an engine
 * configured with a short TTL and a small depth cap. No fleet nodes needed.
 */
describe.skipIf(!pre.ok)('bounded durable mailbox', () => {
  let tmpRoot: string;
  let engine: EngineHandle;
  let workspaceKey: string;
  let sender: string;

  beforeAll(async () => {
    tmpRoot = makeTmpRoot();
    engine = await startEngine(pre.engineServe!, tmpRoot, {
      RELAYCAST_MAILBOX_TTL_MS: '1500',
      RELAYCAST_MAILBOX_DEPTH_CAP: '3',
    });
    workspaceKey = await createWorkspace(engine, 'mailbox-e2e');
    sender = await registerAgent(engine, workspaceKey, 'sender');
  }, 30_000);

  afterAll(async () => {
    await engine?.stop();
    // Keep tmp (incl. serve.log) in CI so the log-upload step can attach it.
    if (tmpRoot && !process.env.CI) cleanupTmp(tmpRoot);
  });

  it('TTL: an undelivered message dead-letters AND the sender is notified (delivery.failed)', async () => {
    const recipient = await registerAgent(engine, workspaceKey, 'ttl-recipient');
    // A workspace observer stream carries the realtime delivery.failed: `stream:read`
    // opens the socket, `deliveries:read` admits the `delivery.*` events.
    const observerToken = await mintObserverToken(engine, workspaceKey, ['stream:read', 'deliveries:read']);
    const senderWs = new ObserverStream(engine.baseUrl.replace(/^http/, 'ws'), observerToken);
    await senderWs.ready();

    const dm = await sendDm(engine, sender, 'ttl-recipient', 'will expire');
    expect(dm.status).toBeLessThan(300);

    // Expiry is scheduled maintenance rather than read-coupled work. The Node
    // adapter sweeps every 15s, dead-lettering the row and fanning
    // delivery.failed to the sender. Poll beyond one full maintenance interval.
    const dead = await waitFor(
      async () => {
        const all = await listDeliveries(engine, recipient, 'dead_lettered');
        return all.find((d) => d.status === 'dead_lettered') ?? null;
      },
      { label: 'message dead-lettered', timeoutMs: 25_000, intervalMs: 400 }
    );
    expect(dead.status).toBe('dead_lettered');

    // The sender receives delivery.failed naming the target + reason.
    const failed = await waitFor(async () => senderWs.ofType('delivery.failed')[0] ?? null, {
      label: 'sender notified delivery.failed',
      timeoutMs: 10_000,
    });
    expect(failed).toMatchObject({ target_agent_name: 'ttl-recipient' });
    senderWs.close();
  }, 35_000);

  // Overflow reject-new is enforced by `belowDepthCapSql` (counts queued+delivered
  // per agent) at delivery-write time, and the sender is notified via the realtime
  // `notifyDeliveryRejections` fanout. Asserting it E2E needs a recipient whose
  // deliveries QUEUE (a via-node agent on a down node) AND whose delivery ledger
  // is externally observable — the spawned agent's token is held by the broker, so
  // it isn't. A self-connected recipient auto-delivers (never queues), so the cap
  // can't be demonstrated through it. The reject-new path + sender feedback are
  // covered directly by the relaycast engine §8.3 mailbox conformance matrix
  // (deny_unknown_fields-controlled delivery state), so it is intentionally not
  // re-asserted here.
});
