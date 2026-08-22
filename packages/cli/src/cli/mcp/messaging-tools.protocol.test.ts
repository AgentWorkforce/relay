import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerMessagingTools } from './messaging-tools.js';

describe('messaging delivery receipts over MCP', () => {
  beforeEach(() => {
    vi.stubEnv('RELAY_ATTEST_SESSION_ID', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      expect(unresolved.isError).toBe(true);
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
        data: undefined,
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

  it('does not echo the sent body back across the MCP boundary', async () => {
    const body = 'CANARY-BODY-'.repeat(400);
    const dm = vi.fn(async () => ({
      // The upstream create-message response carries the body twice.
      conversationId: 'dm_1',
      id: 'msg_1',
      text: body,
      message: { id: 'msg_1', text: body },
    }));
    const server = new McpServer({ name: 'messaging-echo-test', version: '1.0.0' });
    registerMessagingTools(
      server,
      () => ({ dm }) as never,
      async () => [{ name: 'chief' }]
    );

    const client = new Client({ name: 'messaging-echo-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const sent = await client.callTool({
        name: 'send_dm',
        arguments: { to: 'chief', text: body },
      });

      // Neither the rendered content block nor the structured payload may
      // carry the body the caller already holds in its tool_use parameter.
      expect(JSON.stringify(sent.content)).not.toContain('CANARY-BODY');
      expect(JSON.stringify(sent.structuredContent)).not.toContain('CANARY-BODY');

      // The receipt stays small no matter how large the message was.
      expect(JSON.stringify(sent.structuredContent).length).toBeLessThan(600);

      // ...and still says everything the caller needs to act on it.
      expect(sent.structuredContent).toMatchObject({
        id: 'msg_1',
        conversationId: 'dm_1',
        delivery: { status: 'queued_unconfirmed', resolvedRecipient: 'chief' },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('stamps the current replay session on channel, thread, direct, and group messages', async () => {
    vi.stubEnv('RELAY_ATTEST_SESSION_ID', '11111111-1111-4111-8111-111111111111');
    const send = vi.fn(async () => ({ id: 'msg_channel', text: 'channel' }));
    const reply = vi.fn(async () => ({ id: 'msg_reply', text: 'reply' }));
    const dm = vi.fn(async () => ({ id: 'msg_dm', text: 'dm' }));
    const createGroup = vi.fn(async () => ({ id: 'conversation_group' }));
    const sendMessage = vi.fn(async () => ({ id: 'msg_group', text: 'group' }));
    const server = new McpServer({ name: 'messaging-replay-test', version: '1.0.0' });
    registerMessagingTools(
      server,
      () => ({ send, reply, dm, dms: { createGroup, sendMessage } }) as never,
      async () => [{ name: 'chief' }]
    );
    const client = new Client({ name: 'messaging-replay-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const replayData = { session_ref: '11111111-1111-4111-8111-111111111111' };

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: 'post_message',
        arguments: { channel: 'general', text: 'channel' },
      });
      await client.callTool({
        name: 'reply_to_thread',
        arguments: { message_id: 'msg_parent', text: 'reply' },
      });
      await client.callTool({
        name: 'send_dm',
        arguments: { to: 'chief', text: 'dm' },
      });
      await client.callTool({
        name: 'send_group_dm',
        arguments: { participants: ['chief'], text: 'group' },
      });

      expect(send).toHaveBeenCalledWith('general', 'channel', {
        attachments: undefined,
        data: replayData,
        mode: undefined,
      });
      expect(reply).toHaveBeenCalledWith('msg_parent', 'reply', { data: replayData });
      expect(dm).toHaveBeenCalledWith('chief', 'dm', {
        mode: undefined,
        attachments: undefined,
        data: replayData,
      });
      expect(sendMessage).toHaveBeenCalledWith('conversation_group', 'group', {
        data: replayData,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
