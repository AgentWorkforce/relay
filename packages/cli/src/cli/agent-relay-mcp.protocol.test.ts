import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { createAgentRelayMcpServer } from './agent-relay-mcp.js';

describe('Agent Relay MCP initialization', () => {
  it('delivers Relay-first coordination instructions through the MCP protocol', async () => {
    const server = createAgentRelayMcpServer({});
    const client = new Client({ name: 'relay-protocol-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getInstructions()).toContain(
        'Existing Relay participants are not local or built-in subagents'
      );
      expect(client.getInstructions()).toContain('"send_dm"');

      const tools = await client.listTools();
      const spawn = tools.tools.find((tool) => tool.name === 'spawn');
      expect(spawn?.inputSchema.properties).toMatchObject({
        organization: { type: 'string' },
        project: { type: 'string' },
        workstream: { type: 'string' },
        role: { type: 'string' },
        objective: { type: 'string' },
      });
      // Both public spawn schemas must accept the Muse CLI.
      for (const name of ['spawn', 'add_agent'] as const) {
        const tool = tools.tools.find((candidate) => candidate.name === name);
        const props = tool?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
        expect(props?.cli?.enum).toContain('muse');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
