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
  listMessages,
  makeTmpRoot,
  NODE_A_FILE,
  NODE_B_FILE,
  postMessage,
  preflight,
  registerAgent,
  startEngine,
  waitFor,
  type EngineHandle,
} from './harness.js';

/**
 * Two-node fleet E2E (Phase 6). Boots a REAL stack — a relaycast engine (node
 * adapter), two `agent-relay fleet serve` nodes each with their own Rust broker
 * + TS sidecar — and drives the scenario matrix over the live control wire.
 *
 * Skips cleanly (never fails) when prerequisites are absent, so `npm test`
 * stays green without the engine/broker; the dedicated `npm run test:e2e`
 * (and the fleet-e2e CI job) provisions them and runs the full matrix.
 */
const pre = preflight();
if (!pre.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[fleet-e2e] skipped: ${pre.reason}`);
}

describe.skipIf(!pre.ok)('two-node fleet scenario matrix', () => {
  let tmpRoot: string;
  let engine: EngineHandle;
  let workspaceKey: string;
  let driverToken: string;
  let nodeA: FleetNode;
  let nodeB: FleetNode;

  beforeAll(async () => {
    tmpRoot = makeTmpRoot();
    engine = await startEngine(pre.engineServe!, tmpRoot);
    workspaceKey = await createWorkspace(engine, 'fleet-e2e');
    await enableFleet(engine, workspaceKey);

    // node-a: spawn:claude + echo ;  node-b: spawn:codex + ping
    const tokenA = await enrollNode(engine, workspaceKey, 'node_a', 'node-a', ['spawn:claude', 'echo']);
    const tokenB = await enrollNode(engine, workspaceKey, 'node_b', 'node-b', ['spawn:codex', 'ping']);

    nodeA = new FleetNode({
      name: 'node-a', nodeId: 'node_a', nodeFile: NODE_A_FILE, nodeToken: tokenA, workspaceKey,
      engineBaseUrl: engine.baseUrl, brokerBinary: pre.brokerBinary!, tmpRoot, dashboardPort: await getFreePort(),
    });
    nodeB = new FleetNode({
      name: 'node-b', nodeId: 'node_b', nodeFile: NODE_B_FILE, nodeToken: tokenB, workspaceKey,
      engineBaseUrl: engine.baseUrl, brokerBinary: pre.brokerBinary!, tmpRoot, dashboardPort: await getFreePort(),
    });
    nodeA.start();
    nodeB.start();

    driverToken = await registerAgent(engine, workspaceKey, 'driver');

    await waitFor(async () => {
      const nodes = await getNodes(engine, workspaceKey);
      const a = nodes.find((n) => n.name === 'node-a');
      const b = nodes.find((n) => n.name === 'node-b');
      return a?.live && a.handlers_live && b?.live && b.handlers_live ? nodes : null;
    }, { timeoutMs: 45_000, label: 'both nodes online+handlers_live' });
  }, 60_000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    await engine?.stop();
    if (tmpRoot) cleanupTmp(tmpRoot);
  });

  it('boot/register: both nodes appear online with the right capability objects (real broker Bearer auth)', async () => {
    const nodes = await getNodes(engine, workspaceKey);
    const a = nodes.find((n) => n.name === 'node-a')!;
    const b = nodes.find((n) => n.name === 'node-b')!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.live).toBe(true);
    expect(a.handlers_live).toBe(true);
    expect(b.handlers_live).toBe(true);
    const aCaps = a.capabilities.map((c) => c.name).sort();
    const bCaps = b.capabilities.map((c) => c.name).sort();
    expect(aCaps).toEqual(['echo', 'spawn:claude']);
    expect(bCaps).toEqual(['ping', 'spawn:codex']);
  });

  it('capability query: roster filtered by capability returns the right node', async () => {
    const echoNodes = await getNodes(engine, workspaceKey, { capability: 'echo' });
    expect(echoNodes.map((n) => n.name)).toEqual(['node-a']);
    const codexNodes = await getNodes(engine, workspaceKey, { capability: 'spawn:codex' });
    expect(codexNodes.map((n) => n.name)).toEqual(['node-b']);
    const claudeNodes = await getNodes(engine, workspaceKey, { capability: 'spawn:claude' });
    expect(claudeNodes.map((n) => n.name)).toEqual(['node-a']);
  });

  it('cross-node dispatch: invoking a node-native action runs on that node and acks the result', async () => {
    // `echo` lives on node-a; `ping` lives on node-b. Each invocation must be
    // dispatched over the owning node's control connection and complete.
    const echo = await invokeAction(engine, driverToken, 'echo', { text: 'hello-a' });
    expect(echo.status).toBe(201);
    const echoDone = await waitFor(async () => {
      const inv = await getInvocation(engine, driverToken, 'echo', echo.invocationId!);
      return inv.status === 'completed' ? inv : null;
    }, { label: 'echo completed' });
    expect(echoDone.output).toMatchObject({ echoed: 'hello-a', node: 'node-a' });

    const ping = await invokeAction(engine, driverToken, 'ping', { nonce: 'xyz' });
    expect(ping.status).toBe(201);
    const pingDone = await waitFor(async () => {
      const inv = await getInvocation(engine, driverToken, 'ping', ping.invocationId!);
      return inv.status === 'completed' ? inv : null;
    }, { label: 'ping completed' });
    expect(pingDone.output).toMatchObject({ pong: 'xyz', node: 'node-b' });
  });

  it('declarative trigger: a matching channel message fires the action exactly once (loop guard holds)', async () => {
    // Bind #general /deploy/ -> echo (node-a). The node-file `onMessage` trigger
    // is registered via the engine trigger API here because the sidecar's trigger
    // auto-sync is not yet wired (it logs "trigger sync skipped"); the firing +
    // loop-guard behaviour under test is identical either way.
    await createTrigger(engine, workspaceKey, { channel: 'general', pattern: 'deploy', action_name: 'echo' });
    const before = (await listMessages(engine, driverToken, 'general')).filter((m) => m.text?.startsWith('echo:')).length;
    const status = await postMessage(engine, driverToken, 'general', 'please deploy now');
    expect(status).toBe(201);

    // The echo handler re-broadcasts `echo:please deploy now`, which itself
    // contains "deploy". If the loop guard failed, echo messages would grow
    // without bound; assert it settles at exactly one.
    await waitFor(async () => {
      const echoes = (await listMessages(engine, driverToken, 'general')).filter((m) => m.text?.startsWith('echo:'));
      return echoes.length > before ? echoes : null;
    }, { label: 'trigger fired echo' });
    await delay(2_000); // give any (buggy) re-trigger time to pile up
    const after = (await listMessages(engine, driverToken, 'general')).filter((m) => m.text === 'echo:please deploy now');
    expect(after.length).toBe(1);
  });

  it('sidecar crash: killing a node drops handlers_live; restart brings it back', async () => {
    await nodeB.stop();
    await waitFor(async () => {
      const b = (await getNodes(engine, workspaceKey)).find((n) => n.name === 'node-b');
      return b && b.handlers_live === false ? b : null;
    }, { timeoutMs: 30_000, label: 'node-b handlers_live false after crash' });

    nodeB.start();
    await waitFor(async () => {
      const b = (await getNodes(engine, workspaceKey)).find((n) => n.name === 'node-b');
      return b?.live && b.handlers_live ? b : null;
    }, { timeoutMs: 45_000, label: 'node-b back online after restart' });

    // After reconcile, dispatch still lands on node-b with no duplication.
    const ping = await invokeAction(engine, driverToken, 'ping', { nonce: 'after-restart' });
    const done = await waitFor(async () => {
      const inv = await getInvocation(engine, driverToken, 'ping', ping.invocationId!);
      return inv.status === 'completed' ? inv : null;
    }, { label: 'ping after restart' });
    expect(done.output).toMatchObject({ pong: 'after-restart', node: 'node-b' });
  }, 90_000);

  // Runs last: a targeted spawn leaves a never-connecting stub agent pending on
  // the node, which would pollute the dispatch assertions above.
  it('spawn placement: targeted spawn routes to the named node; capability-routed spawn routes to the only eligible node', async () => {
    // Asserts placement (which node the spawn is dispatched to over the control
    // connection) — the part unique to the two-node topology. Full agent bring-up
    // (the spawned PTY child connecting back) needs a real connecting harness and
    // is exercised by the relaycast engine conformance suite, not here.

    // Targeted: spawn:claude only exists on node-a; target it by name.
    const spawnA = await invokeAction(engine, driverToken, 'spawn', { cli: 'claude', name: 'worker-a', target_node: 'node-a' });
    expect(spawnA.status).toBe(201);
    expect(spawnA.body.data.handler_node_id).toBe('node_a');
    expect(spawnA.body.data.dispatched_node_id).toBe('node_a');

    // Capability-routed: only node-b advertises spawn:codex, so placement must
    // pick node-b without an explicit target.
    const spawnB = await invokeAction(engine, driverToken, 'spawn', { cli: 'codex', name: 'worker-b' });
    expect(spawnB.status).toBe(201);
    expect(spawnB.body.data.handler_node_id).toBe('node_b');
    expect(spawnB.body.data.dispatched_node_id).toBe('node_b');

    // A capability no node advertises must fail placement cleanly.
    const spawnNone = await invokeAction(engine, driverToken, 'spawn', { cli: 'claude', name: 'worker-x', target_node: 'node-b' });
    // node-b lacks spawn:claude → hard capability-mismatch failure, not a misroute.
    expect(spawnNone.status).toBeGreaterThanOrEqual(400);
  });
});
