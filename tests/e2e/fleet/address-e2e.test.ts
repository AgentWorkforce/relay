import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTmp,
  createWorkspace,
  FleetNode,
  getInvocation,
  getNodes,
  invokeAction,
  makeTmpRoot,
  preflight,
  registerAgent,
  startCloudEnrollmentEndpoint,
  startEngine,
  waitFor,
  type EngineHandle,
} from './harness.js';

/**
 * `agent@machine` addressing (relaycast `POST /v1/dm` with `address`) against a real
 * engine and a real `relay node up` (Rust broker + sidecar) enrolled the way a
 * Cloud sandbox is: through `relay cloud enroll`, named `fleet-sandbox-<uuid>`,
 * carrying server-owned `cloud:*` tags, with no machine_id.
 *
 * Skips cleanly when prerequisites are absent (see harness preflight).
 */
const pre = preflight();

const SANDBOX_UUID = '0b7c2f4e-5d1a-4c3b-9e8f-7a6b5c4d3e2f';
const SANDBOX_NODE_NAME = `fleet-sandbox-${SANDBOX_UUID}`; // matches nodes/sandbox.ts
const SANDBOX_NODE_ID = 'node_fleet_sandbox';
const SANDBOX_NODE_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'nodes', 'sandbox.ts');
const AGENT = 'sbx-worker';
const ADDRESS = `${AGENT}@${SANDBOX_NODE_NAME}`;

describe.skipIf(!pre.ok)('agent@machine addressing to a Cloud-shaped sandbox node', () => {
  let tmpRoot: string;
  let engine: EngineHandle;
  let workspaceKey: string;
  let driverToken: string;
  let sandbox: FleetNode;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const sendTo = (address: string, text: string, headers: Record<string, string> = {}) =>
    engine.fetchJson('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(driverToken), ...headers },
      body: JSON.stringify({ address, text }),
    });

  const agentAddress = async (name: string) => {
    const { status, body } = await engine.fetchJson(`/v1/agents/${name}`, { headers: auth(workspaceKey) });
    expect(status).toBe(200);
    return body.data.address as string | null;
  };

  /** The stub PTY agent writes one file per nonce it reads from its terminal. */
  const waitForNonce = (nonce: string, label: string) =>
    waitFor(
      async () => {
        try {
          return JSON.parse(
            readFileSync(
              path.join(sandbox.projectDir, '.agentworkforce', 'relay', 'e2e-brief-actions', `${nonce}.json`),
              'utf8'
            )
          ) as { nonce: string; agent: string; node: string };
        } catch {
          return null;
        }
      },
      { label, timeoutMs: 40_000 }
    );

  beforeAll(async () => {
    tmpRoot = makeTmpRoot();
    engine = await startEngine(pre.engineServe!, tmpRoot);
    workspaceKey = await createWorkspace(engine, 'address-e2e');
    driverToken = await registerAgent(engine, workspaceKey, 'driver');

    // Cloud's register route enrolls the node on the sandbox's behalf with its
    // provider/sandbox-id tags; model that exact POST /v1/nodes body.
    const enrolled = await engine.fetchJson('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(workspaceKey) },
      body: JSON.stringify({
        node_id: SANDBOX_NODE_ID,
        name: SANDBOX_NODE_NAME,
        capabilities: ['spawn:claude', 'sandbox:ping'],
        max_agents: 1,
        tags: ['cloud:sandbox-provider:daytona', `cloud:sandbox-id:sbx_${SANDBOX_UUID}`],
      }),
    });
    expect(enrolled.status).toBe(201);

    const enrollmentToken = 'ocl_node_enr_address_e2e';
    const endpoint = await startCloudEnrollmentEndpoint({
      enrollmentToken,
      nodeId: SANDBOX_NODE_ID,
      nodeName: SANDBOX_NODE_NAME,
      nodeToken: enrolled.body.data.token,
      relayWorkspaceId: 'fleet-e2e',
      relaycastUrl: engine.baseUrl,
    });
    sandbox = new FleetNode({
      name: SANDBOX_NODE_NAME,
      nodeId: SANDBOX_NODE_ID,
      nodeFile: SANDBOX_NODE_FILE,
      nodeToken: enrolled.body.data.token,
      workspaceKey,
      engineBaseUrl: engine.baseUrl,
      brokerBinary: pre.brokerBinary!,
      tmpRoot,
      capacityHarnesses: 'claude',
      usePersistedEnrollment: true,
    });
    try {
      await sandbox.cloudEnroll(endpoint.url, enrollmentToken);
    } finally {
      await endpoint.stop();
    }
    sandbox.start();

    await waitFor(
      async () => {
        const [node] = await getNodes(engine, workspaceKey, { name: SANDBOX_NODE_NAME });
        return node?.live &&
          node.handlers_live &&
          node.capabilities.some((capability) => capability.name === 'sandbox:ping')
          ? node
          : null;
      },
      { timeoutMs: 45_000, label: 'sandbox node online with its sidecar provider' }
    );

    // Spawn a real PTY agent onto the sandbox and wait until it has provably
    // acted on its brief, so later injections land after harness readiness.
    const briefNonce = `address-brief-${Date.now().toString(36)}`;
    const spawn = await invokeAction(engine, driverToken, 'spawn', {
      cli: 'claude',
      name: AGENT,
      target_node: SANDBOX_NODE_NAME,
      task: `Record RELAY_E2E_BRIEF_NONCE=${briefNonce} `,
    });
    expect(spawn.status).toBe(201);
    const done = await waitFor(
      async () => {
        const invocation = await getInvocation(engine, driverToken, 'spawn', spawn.invocationId!);
        return invocation.status === 'completed' || invocation.status === 'failed' ? invocation : null;
      },
      { label: 'sandbox spawn settled', timeoutMs: 35_000 }
    );
    expect(done.status).toBe('completed');
    await waitForNonce(briefNonce, 'spawned agent acted on its brief');
  }, 150_000);

  afterAll(async () => {
    await sandbox?.stop();
    await engine?.stop();
    if (tmpRoot && !process.env.CI) cleanupTmp(tmpRoot);
  });

  it("reports the sandboxed agent's address from its sandbox node name", async () => {
    expect(await agentAddress(AGENT)).toBe(ADDRESS);
    expect(await agentAddress('driver')).toBe('driver@direct');
  });

  it('delivers a DM sent to agent@machine into the agent process on that sandbox', async () => {
    const nonce = `address-dm-${Date.now().toString(36)}`;
    const res = await sendTo(ADDRESS, `Record RELAY_E2E_BRIEF_NONCE=${nonce} `);
    expect(res.status).toBe(201);
    // The recipient is handed the sender's address to reply on.
    expect(res.body.data.message.agent_address).toBe('driver@direct');

    const observed = await waitForNonce(nonce, 'addressed DM reached the sandboxed PTY agent');
    expect(observed).toMatchObject({ nonce, agent: AGENT, node: SANDBOX_NODE_NAME });
  }, 60_000);

  it('replays an idempotent retry instead of injecting twice', async () => {
    const key = { 'Idempotency-Key': `address-e2e-${Date.now()}` };
    const first = await sendTo(ADDRESS, 'once', key);
    const retry = await sendTo(ADDRESS, 'once', key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
  });

  it('rejects addresses that do not name where the agent runs', async () => {
    for (const address of [
      `${AGENT}@direct`,
      `${AGENT}@sbx_${SANDBOX_UUID}`, // cloud:* tags are not machine names
      `${AGENT}@fleet-sandbox-00000000-0000-4000-8000-000000000000`,
      `nobody@${SANDBOX_NODE_NAME}`,
    ]) {
      const res = await sendTo(address, 'x');
      expect(res.status, address).toBe(404);
      expect(res.body.error.code).toBe('address_not_found');
    }
    expect((await sendTo(AGENT, 'x')).status).toBe(400);
  });

  it('leaves the agent unaddressable once the sandbox is torn down', async () => {
    // Cloud's teardown: the sandbox goes away, then its node row is deleted
    // outright (relaycast-cloud fleet/routes.ts handleDeleteNode), which nulls
    // the agent's location through the foreign key.
    await sandbox.stop();
    await waitFor(
      async () => {
        const [node] = await getNodes(engine, workspaceKey, { name: SANDBOX_NODE_NAME });
        return node && !node.live ? node : null;
      },
      { timeoutMs: 30_000, label: 'sandbox node offline' }
    );
    const db = new DatabaseSync(path.join(tmpRoot, 'relaycast.db'));
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.prepare('DELETE FROM nodes WHERE id = ?').run(SANDBOX_NODE_ID);
    } finally {
      db.close();
    }

    expect(await agentAddress(AGENT)).toBeNull();
    for (const address of [ADDRESS, `${AGENT}@direct`]) {
      const res = await sendTo(address, 'into the void');
      expect(res.status, address).toBe(404);
      expect(res.body.error.code).toBe('address_not_found');
    }
  }, 60_000);
});
