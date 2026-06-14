import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTmp,
  createTrigger,
  createWorkspace,
  delay,
  enableFleet,
  enrollNode,
  FleetNode,
  getFreePort,
  getInvocation,
  getNodes,
  invokeAction,
  joinChannel,
  listDeliveries,
  listMessages,
  makeTmpRoot,
  NODE_A_FILE,
  NODE_B_FILE,
  postMessage,
  preflight,
  registerAgent,
  releaseAgent,
  sendDm,
  startEngine,
  waitFor,
  type EngineHandle,
  type NodeRosterEntry,
} from './harness.js';

/**
 * Two-node fleet E2E (Phase 6). Boots a REAL stack — a relaycast engine (node
 * adapter), two `agent-relay fleet serve` nodes each with their own Rust broker
 * + TS sidecar — and drives the scenario matrix over the live control wire.
 *
 * Skips cleanly (never fails) when prerequisites are absent.
 */
const pre = preflight();
if (!pre.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[fleet-e2e] skipped: ${pre.reason}`);
}

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
    await enableFleet(engine, workspaceKey);

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
      dashboardPort: await getFreePort(),
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
      dashboardPort: await getFreePort(),
    });
    nodeA.start();
    nodeB.start();

    driverToken = await registerAgent(engine, workspaceKey, 'driver');

    await waitFor(
      async () => {
        const nodes = await getNodes(engine, workspaceKey);
        const a = node(nodes, 'node-a');
        const b = node(nodes, 'node-b');
        return a?.live && a.handlers_live && b?.live && b.handlers_live ? nodes : null;
      },
      { timeoutMs: 45_000, label: 'both nodes online+handlers_live' }
    );
  }, 60_000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    await engine?.stop();
    if (tmpRoot) cleanupTmp(tmpRoot);
  });

  it('boot/register: both nodes online with the right capability objects (real broker Bearer auth)', async () => {
    const nodes = await getNodes(engine, workspaceKey);
    const a = node(nodes, 'node-a')!;
    const b = node(nodes, 'node-b')!;
    expect(a.live).toBe(true);
    expect(a.handlers_live).toBe(true);
    expect(b.handlers_live).toBe(true);
    expect(a.capabilities.map((c) => c.name).sort()).toEqual(['echo', 'spawn:claude', 'spawn:pool', 'work']);
    expect(b.capabilities.map((c) => c.name).sort()).toEqual(['ping', 'spawn:codex', 'spawn:pool', 'work']);
  });

  it('negative auth: a node whose broker presents a bogus token never comes online', async () => {
    // Enrolled (valid roster row) but the broker is handed a wrong token, so the
    // node_control Bearer handshake is rejected → never reaches handlers_live.
    // Guards against a regression that disables node-auth enforcement.
    await enrollNode(engine, workspaceKey, 'node_c', 'node-c', ['work']);
    const badNode = new FleetNode({
      name: 'node-c',
      nodeId: 'node_c',
      nodeFile: NODE_B_FILE,
      nodeToken: 'nt_live_bogustoken0000000000000000',
      workspaceKey,
      engineBaseUrl: engine.baseUrl,
      brokerBinary: pre.brokerBinary!,
      tmpRoot,
      dashboardPort: await getFreePort(),
    });
    badNode.start();
    try {
      // Give it ample time to (fail to) authenticate, then assert it never went live.
      await delay(8_000);
      const c = node(await getNodes(engine, workspaceKey), 'node-c');
      expect(c?.handlers_live ?? false).toBe(false);
      expect(c?.live ?? false).toBe(false);
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

  it('cross-node dispatch: a node-native action runs on its owning node and acks the result', async () => {
    const echo = await invokeAction(engine, driverToken, 'echo', { text: 'hello-a' });
    expect(echo.status).toBe(201);
    const echoDone = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'echo', echo.invocationId!);
        return inv.status === 'completed' ? inv : null;
      },
      { label: 'echo completed' }
    );
    expect(echoDone.output).toMatchObject({ echoed: 'hello-a', node: 'node-a' });

    const ping = await invokeAction(engine, driverToken, 'ping', { nonce: 'xyz' });
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

  it('spawn completes end-to-end: targeted spawn mints+injects the token, binds the agent via-node, node reports it', async () => {
    // Regression guard for the token-authority handshake (engine agent.register
    // reply frame ↔ broker). Before the fix this hung to a 30s timeout.
    const before = node(await getNodes(engine, workspaceKey), 'node-a')!.active_agents;
    const spawn = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'claude',
      name: 'worker-a',
      target_node: 'node-a',
    });
    expect(spawn.status).toBe(201);
    expect(spawn.body.data.handler_node_id).toBe('node_a');

    const done = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'spawn', spawn.invocationId!);
        return inv.status === 'completed' || inv.status === 'failed' ? inv : null;
      },
      { label: 'spawn settled', timeoutMs: 20_000 }
    );
    expect(done.status).toBe('completed'); // the agent registered + token minted, not a timeout

    // The broker bound the agent via-node and heartbeated the count up.
    await waitFor(
      async () => {
        const a = node(await getNodes(engine, workspaceKey), 'node-a');
        return a && a.active_agents > before ? a : null;
      },
      { label: 'node-a active_agents incremented', timeoutMs: 20_000 }
    );
  }, 45_000);

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

  it('resume: a resumable spawn carries session_ref and resume re-targets the origin node', async () => {
    const sessionRef = 'sess-resume-1';
    const first = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'pool',
      name: 'resumable-1',
      target_node: 'node-a',
      session_ref: sessionRef,
    });
    const firstDone = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'spawn', first.invocationId!);
        return inv.status === 'completed' || inv.status === 'failed' ? inv : null;
      },
      { label: 'resumable spawn settled', timeoutMs: 20_000 }
    );
    expect(firstDone.status).toBe('completed'); // resumable spawn carried session_ref through token authority

    // Release the agent, then resume = an origin-targeted spawn carrying the same
    // session_ref. Assert placement re-binds to the ORIGIN node (the resume
    // contract); full re-attach of the stub child is covered by engine conformance.
    expect(await releaseAgent(engine, workspaceKey, 'resumable-1')).toBeLessThan(300);
    const resume = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'pool',
      name: 'resumable-1',
      target_node: 'node-a',
      session_ref: sessionRef,
    });
    expect(resume.status).toBe(201);
    expect(resume.body.data.handler_node_id).toBe('node_a'); // resumed on the origin node
    expect(resume.body.data.dispatched_node_id).toBe('node_a');
  }, 45_000);

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
    // `work` lives on BOTH nodes but binds to whichever registered it first, so
    // discover where it dispatches, then kill THAT node mid-flight.
    const work = await invokeAction(engine, driverToken, 'work', { nonce: 'resched-1', delayMs: 6_000 });
    const homeId = work.body.data.handler_node_id as string; // 'node_a' | 'node_b'
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

    // (d) dispatch works again, and the settled invocation stays idempotent.
    const ping = await invokeAction(engine, driverToken, 'ping', {
      nonce: 'after-restart',
      target_node: 'node-b',
    });
    const pingDone = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'ping', ping.invocationId!);
        return inv.status === 'completed' ? inv : null;
      },
      { label: 'ping after restart', timeoutMs: 20_000 }
    );
    expect(pingDone.output).toMatchObject({ pong: 'after-restart' });
    const again = await getInvocation(engine, driverToken, 'ping', ping.invocationId!);
    expect(again.status).toBe('completed');
    expect(again.output).toMatchObject({ pong: 'after-restart' });
  }, 120_000);
});

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
    if (tmpRoot) cleanupTmp(tmpRoot);
  });

  it('TTL: an undelivered message dead-letters after the TTL', async () => {
    // recipient registers but never connects/reads, so the DM stays queued.
    const recipient = await registerAgent(engine, workspaceKey, 'ttl-recipient');
    const dm = await sendDm(engine, sender, 'ttl-recipient', 'will expire');
    expect(dm.status).toBeLessThan(300);

    // Reading with ?status=dead_lettered triggers the TTL sweep (the route sweeps
    // on every read) and surfaces the dead-lettered row once the TTL elapses.
    const dead = await waitFor(
      async () => {
        const all = await listDeliveries(engine, recipient, 'dead_lettered');
        return all.find((d) => d.status === 'dead_lettered') ?? null;
      },
      { label: 'message dead-lettered', timeoutMs: 15_000, intervalMs: 400 }
    );
    expect(dead.status).toBe('dead_lettered');
  }, 20_000);

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
