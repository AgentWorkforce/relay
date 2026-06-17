import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentEventListener,
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
    expect(a.capabilities.map((c) => c.name).sort()).toEqual(['echo', 'spawn:claude', 'spawn:pool', 'work']);
    expect(b.capabilities.map((c) => c.name).sort()).toEqual(['ping', 'spawn:codex', 'spawn:pool', 'work']);
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
      workspaceKey,
      engineBaseUrl: engine.baseUrl,
      brokerBinary: pre.brokerBinary!,
      tmpRoot,
      dashboardPort: await getFreePort(),
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

    // (e) dispatch works again on the restored node.
    const ping = await invokeAction(engine, driverToken, 'ping', { nonce: 'after-restart' });
    const pingDone = await waitFor(
      async () => {
        const inv = await getInvocation(engine, driverToken, 'ping', ping.invocationId!);
        return inv.status === 'completed' ? inv : null;
      },
      { label: 'ping after restart', timeoutMs: 20_000 }
    );
    expect(pingDone.output).toMatchObject({ pong: 'after-restart', node: 'node-b' });
  }, 120_000);

  it('delivery seq/dedup: per-agent deliveries are strictly monotonic and a resync replays with no duplicates', async () => {
    // Asserts the engine's exactly-once delivery cursor — the SAME monotonic-seq +
    // dedup mechanism the node-restart reconcile (inventory.sync) relies on for
    // redelivery without duplicates. Driven through a WS-connected recipient whose
    // event stream IS observable (a spawned via-node child's stream is not).
    const recipient = await registerAgent(engine, workspaceKey, 'seq-rx');
    const listener = new AgentEventListener(engine.baseUrl.replace(/^http/, 'ws'), recipient);
    await listener.ready();

    const N = 4;
    for (let i = 0; i < N; i++) {
      expect((await sendDm(engine, driverToken, 'seq-rx', `seq-${i}`)).status).toBeLessThan(300);
    }
    await waitFor(async () => listener.ofType('dm.received').length >= N, { label: 'all DMs delivered' });

    const seqs = listener.ofType('dm.received').map((e) => e.agent_seq as number);
    expect(seqs).toHaveLength(N);
    expect(new Set(seqs).size).toBe(N); // no duplicate delivery
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // strictly monotonic, in order
    const maxSeq = Math.max(...seqs);

    // Resync a FRESH connection from the midpoint: the engine must replay EXACTLY
    // the tail after the cursor — no more, no less.
    const cursor = seqs[1];
    const expectedTail = seqs.filter((s) => s > cursor); // e.g. [3, 4]
    const replay = new AgentEventListener(engine.baseUrl.replace(/^http/, 'ws'), recipient);
    await replay.ready();
    replay.resync(cursor);
    const ack = await waitFor(async () => replay.ofType('resync_ack')[0] ?? null, { label: 'resync_ack' });
    expect(ack).toMatchObject({ last_seen_seq: cursor, current_seq: maxSeq, gap_detected: false });

    // The UNFILTERED replayed dm.received seqs must equal the expected tail exactly,
    // in order. This fails on BOTH over-delivery (replaying acked history) and
    // under-delivery (replaying nothing) — the previous filtered check passed both.
    await waitFor(async () => replay.ofType('dm.received').length >= expectedTail.length, {
      label: 'tail replayed',
    });
    await delay(1_000); // settle so any over-delivery surfaces before asserting
    const replayedSeqs = replay.ofType('dm.received').map((e) => e.agent_seq as number);
    expect(replayedSeqs).toEqual(expectedTail);

    listener.close();
    replay.close();
  }, 30_000);
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
    // Keep tmp (incl. serve.log) in CI so the log-upload step can attach it.
    if (tmpRoot && !process.env.CI) cleanupTmp(tmpRoot);
  });

  it('TTL: an undelivered message dead-letters AND the sender is notified (delivery.failed)', async () => {
    const recipient = await registerAgent(engine, workspaceKey, 'ttl-recipient');
    // The sender holds a live WS so it can observe the realtime delivery.failed.
    const senderWs = new AgentEventListener(engine.baseUrl.replace(/^http/, 'ws'), sender);
    await senderWs.ready();

    const dm = await sendDm(engine, sender, 'ttl-recipient', 'will expire');
    expect(dm.status).toBeLessThan(300);

    // Reading with ?status=dead_lettered triggers the TTL sweep (the route sweeps
    // on every read), which dead-letters the row AND fans delivery.failed to the
    // sender. Poll past the TTL.
    const dead = await waitFor(
      async () => {
        const all = await listDeliveries(engine, recipient, 'dead_lettered');
        return all.find((d) => d.status === 'dead_lettered') ?? null;
      },
      { label: 'message dead-lettered', timeoutMs: 15_000, intervalMs: 400 }
    );
    expect(dead.status).toBe('dead_lettered');

    // The sender receives delivery.failed naming the target + reason.
    const failed = await waitFor(async () => senderWs.ofType('delivery.failed')[0] ?? null, {
      label: 'sender notified delivery.failed',
      timeoutMs: 10_000,
    });
    expect(failed).toMatchObject({ target_agent_name: 'ttl-recipient' });
    senderWs.close();
  }, 25_000);

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
