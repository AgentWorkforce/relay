import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { registerMessagingTools } from './messaging-tools.js';

describe('messaging delivery receipts over MCP', () => {
  it('exposes enqueue state on send and an explicit signal for an empty reader list', async () => {
    const dm = vi.fn(async () => ({ id: 'msg_1', text: 'hello' }));
    const readers = vi.fn(async () => []);
    const server = new McpServer({ name: 'messaging-test', version: '1.0.0' });
    registerMessagingTools(
      server,
      () => ({ dm, readers }) as never,
      async () => [{ name: 'chief' }, { name: 'chief-khaliq' }]
    );

    const client = new Client({ name: 'messaging-client-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const sent = await client.callTool({
        name: 'send_dm',
        arguments: { to: 'chief-khaliq', text: 'hello' },
      });
      expect(sent.structuredContent).toMatchObject({
        id: 'msg_1',
        target: { kind: 'agent', agentName: 'chief-khaliq' },
        delivery: {
          status: 'queued_unconfirmed',
          mode: 'wait',
          requestedRecipient: 'chief-khaliq',
          resolvedRecipient: 'chief-khaliq',
          readConfirmed: false,
        },
      });

      const unresolved = await client.callTool({
        name: 'send_dm',
        arguments: { to: 'missing-agent', text: 'still enqueue this' },
      });
      expect(unresolved.isError).not.toBe(true);
      expect(unresolved.structuredContent).toMatchObject({
        id: 'msg_1',
        delivery: {
          status: 'recipient_unresolved',
          requestedRecipient: 'missing-agent',
          resolvedRecipient: null,
          recipientMatched: null,
          readConfirmed: false,
        },
      });
      expect(unresolved.structuredContent).not.toHaveProperty('target');
      expect(dm).toHaveBeenLastCalledWith('missing-agent', 'still enqueue this', {
        mode: undefined,
        attachments: undefined,
      });

      const unread = await client.callTool({
        name: 'get_message_readers',
        arguments: { message_id: 'msg_1' },
      });
      expect(unread.structuredContent).toMatchObject({
        readers: [],
        delivery: { status: 'queued_or_unread', readConfirmed: false },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
