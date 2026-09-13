/**
 * relay#1563 / PR #1751 — spawn lifecycle truth, MCP surface.
 *
 * Copied by run.mjs into `<target>/.relay-pr-proof/` before execution so its
 * bare imports (`@modelcontextprotocol/sdk`) resolve against the exact target
 * checkout's own node_modules, and its relative import of `agent-relay-mcp.js`
 * loads the exact built CLI dist module — the real MCP `spawn` tool the PR
 * claims to have fixed, driven over the real MCP client/server protocol
 * (`InMemoryTransport`), not a hand-rolled stand-in for it.
 *
 * `createAgentRelayMcpServer`'s `spawn` tool builds its own
 * `new AgentRelay({ agentToken, baseUrl })` per call and hits the real
 * `@relaycast/sdk` wire contract (`POST /v1/actions/spawn/invoke`,
 * `GET /v1/actions/spawn/invocations/:id`) — the same envelope
 * (`{ ok, data }`, snake_case keys camelCased on the way back) a real
 * Relaycast deployment uses. `run.mjs` stands up a tiny HTTP server that
 * speaks exactly that contract so this probe can force each lifecycle branch
 * deterministically without a live Relaycast.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createAgentRelayMcpServer } from '../packages/cli/dist/cli/agent-relay-mcp.js';

const baseUrl = requiredValue('RELAY_PR_PROOF_1563_BASE_URL');

async function callSpawn(agentName) {
  const server = createAgentRelayMcpServer({ agentToken: 'relayflow-1563-agent-token', baseUrl });
  const client = new Client({ name: 'relayflow-1563-spawn-probe', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({
      name: 'spawn',
      arguments: { name: agentName, cli: 'claude', task: 'relayflow-1563 mcp spawn probe' },
    });
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

const scenarios = {
  unproven: 'relayflow-1563-unproven',
  unconfirmed: 'relayflow-1563-unconfirmed',
  failed: 'relayflow-1563-failed',
  // relay#1563 Medium (MCP): the ack never carries a node id and starts
  // `pending`, but the later terminal read reports `failed` (also without a
  // node id) — proving a bare status change on a *later* invocation record
  // cannot manufacture `dispatched` for an ack that was frozen
  // `not_dispatched`.
  noRouteFailed: 'relayflow-1563-no-route-failed',
};

const results = {};
for (const [key, agentName] of Object.entries(scenarios)) {
  results[key] = await callSpawn(agentName);
}

process.stdout.write(`${JSON.stringify(results)}\n`);

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}
