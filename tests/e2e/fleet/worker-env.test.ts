import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTmp,
  createWorkspace,
  enrollNode,
  ENV_PROBE_NODE_FILE,
  FleetNode,
  getInvocation,
  getNodes,
  invokeAction,
  makeTmpRoot,
  preflight,
  registerAgent,
  startEngine,
  waitFor,
  type EngineHandle,
} from './harness.js';

/**
 * Worker environment regression: a spawned agent must not inherit the
 * broker's own credentials. The node is started the way `node up` runs in
 * production (node token + workspace key in the broker's environment), and a
 * probe harness records only the NAMES of relay credential-like variables it
 * can see. Values are never read or printed.
 */
const pre = preflight();

describe.skipIf(!pre.ok)('spawned worker environment', () => {
  let tmpRoot: string;
  let engine: EngineHandle;
  let workspaceKey: string;
  let driverToken: string;
  let probeNode: FleetNode;

  beforeAll(async () => {
    tmpRoot = makeTmpRoot();
    engine = await startEngine(pre.engineServe!, tmpRoot);
    workspaceKey = await createWorkspace(engine, 'worker-env-e2e');
    const nodeToken = await enrollNode(engine, workspaceKey, 'node_env_probe', 'env-probe', [
      'spawn:claude',
      'envprobe:ready',
    ]);
    probeNode = new FleetNode({
      name: 'env-probe',
      nodeId: 'node_env_probe',
      nodeFile: ENV_PROBE_NODE_FILE,
      nodeToken,
      workspaceKey,
      engineBaseUrl: engine.baseUrl,
      brokerBinary: pre.brokerBinary!,
      tmpRoot,
      capacityHarnesses: 'claude',
    });
    probeNode.start();
    driverToken = await registerAgent(engine, workspaceKey, 'env-driver');

    // Wait for the sidecar-only action: until it is registered the broker's
    // native provider could serve `spawn:claude` with a real CLI.
    await waitFor(
      async () => {
        const nodes = await getNodes(engine, workspaceKey, { name: 'env-probe' });
        const match = nodes.find((entry) => entry.name === 'env-probe');
        return match?.live &&
          match.handlers_live &&
          match.capabilities.some((capability) => capability.name === 'envprobe:ready')
          ? match
          : null;
      },
      { timeoutMs: 45_000, label: 'env-probe node online with sidecar handlers' }
    );
  }, 90_000);

  afterAll(async () => {
    await probeNode?.stop();
    await engine?.stop();
    if (tmpRoot && !process.env.CI) cleanupTmp(tmpRoot);
  });

  it('holds only its own token plus the workspace credentials the broker delegates', async () => {
    const agent = 'env-probe-worker';
    const spawn = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'claude',
      name: agent,
      target_node: 'env-probe',
    });
    expect(spawn.status).toBe(201);

    const done = await waitFor(
      async () => {
        const invocation = await getInvocation(engine, driverToken, 'spawn', spawn.invocationId!);
        return invocation.status === 'completed' || invocation.status === 'failed' ? invocation : null;
      },
      { label: `${agent} spawn settled`, timeoutMs: 35_000 }
    );
    expect(done.status).toBe('completed');

    const probePath = path.join(
      probeNode.projectDir,
      '.agentworkforce',
      'relay',
      'e2e-env-probe',
      `${agent}.json`
    );
    const probe = await waitFor(
      async () => {
        try {
          return JSON.parse(readFileSync(probePath, 'utf8')) as { agent: string; names: string[] };
        } catch {
          return null;
        }
      },
      { label: `${agent} recorded its environment names`, timeoutMs: 20_000 }
    );

    // The broker's own API key, the node token, and the broker's identity
    // proof never reach an agent.
    expect(probe.names).not.toContain('RELAY_BROKER_API_KEY');
    expect(probe.names).not.toContain('RELAY_NODE_TOKEN');
    expect(probe.names).not.toContain('RELAY_AGENT_IDENTITY_KEY');
    // Exactly: the agent's own token, plus the workspace credentials the
    // broker deliberately delegates so the agent's relay tools can spawn and
    // list workers (add_agent, list_agents, query_nodes).
    expect(probe.names).toEqual([
      'AGENT_RELAY_WORKSPACE_KEY',
      'RELAY_AGENT_TOKEN',
      'RELAY_API_KEY',
      'RELAY_WORKSPACES_JSON',
      'RELAY_WORKSPACE_KEY',
    ]);
  });
});
