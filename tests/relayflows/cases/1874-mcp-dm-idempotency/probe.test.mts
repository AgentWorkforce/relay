import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { it } from 'vitest';

it('records a send through a fresh MCP replay cache and the real Relaycast SDK', async () => {
  const target = process.env.RELAY_PR_PROOF_TARGET_DIR!;
  const { registerMessagingTools } = await import(
    pathToFileURL(`${target}/packages/cli/src/cli/mcp/messaging-tools.ts`).href
  );
  const { McpRequestReplay } = await import(
    pathToFileURL(`${target}/packages/cli/src/cli/mcp/request-replay.ts`).href
  );
  const { createAgentClient } = await import(
    pathToFileURL(`${target}/packages/sdk/src/messaging/thin-client.ts`).href
  );
  const agent = createAgentClient({ agentToken: 'at_local_proof', baseUrl: process.env.DM_PROOF_BASE_URL! });
  const server = new McpServer({ name: 'dm-proof', version: '1.0.0' });
  registerMessagingTools(
    server,
    () => agent,
    async () => [{ name: 'chief' }],
    new McpRequestReplay()
  );
  const client = new Client({ name: 'dm-proof-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'send_dm',
      arguments: {
        to: 'chief',
        text: 'process-boundary-proof',
        ...(process.env.DM_PROOF_KEY ? { idempotency_key: process.env.DM_PROOF_KEY } : {}),
      },
    });
    if (result.isError || !result.structuredContent)
      throw new Error(`send_dm failed: ${JSON.stringify(result)}`);
    await writeFile(process.env.DM_PROOF_RECEIPT!, JSON.stringify(result.structuredContent));
  } finally {
    await client.close();
    await server.close();
  }
});
