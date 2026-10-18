import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { acknowledgePtyMessageRead } from './pty-delivery-ack.js';
import { registerMessagingTools } from './messaging-tools.js';

describe('PTY native inbox receipts', () => {
  let directory: string;
  const messageId = '../msg/one';
  const key = createHash('sha256').update(messageId).digest('hex');

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'relay-ack-test-'));
    vi.stubEnv('RELAY_PTY_ACK_DIR', directory);
    vi.stubEnv('RELAY_AGENT_NAME', 'recipient');
    await writeFile(
      path.join(directory, `${key}.pending`),
      JSON.stringify({ messageId, nonce: '11111111-1111-4111-8111-111111111111' })
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('publishes the nonce for the matching read without using message IDs as paths', async () => {
    await acknowledgePtyMessageRead(messageId);
    expect(
      await readFile(path.join(directory, `${key}.11111111-1111-4111-8111-111111111111.read`), 'utf8')
    ).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('does not acknowledge a read performed as another identity', async () => {
    await acknowledgePtyMessageRead(messageId, 'other-agent');
    await expect(
      readFile(path.join(directory, `${key}.11111111-1111-4111-8111-111111111111.read`))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores receipts without a matching pending message', async () => {
    await writeFile(
      path.join(directory, `${key}.pending`),
      JSON.stringify({ messageId: 'different', nonce: '11111111-1111-4111-8111-111111111111' })
    );
    await acknowledgePtyMessageRead(messageId);
    await expect(
      readFile(path.join(directory, `${key}.11111111-1111-4111-8111-111111111111.read`))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(acknowledgePtyMessageRead('not-pending')).resolves.toBe(false);
  });

  it.each([
    ['mark_message_read', false],
    ['mark_message_read', true],
    ['acknowledge_delivery', false],
  ] as const)('acknowledges through MCP %s (failure=%s)', async (tool, fail) => {
    const server = new McpServer({ name: 'native-ack-test', version: '1.0.0' });
    const client = new Client({ name: 'recipient', version: '1.0.0' });
    const markRead = vi.fn(async () => {
      if (fail) throw new Error('read rejected');
    });
    registerMessagingTools(
      server,
      () => ({ markRead }) as never,
      async () => []
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: tool,
        arguments: { message_id: messageId },
      });
      if (tool === 'mark_message_read') expect(markRead).toHaveBeenCalledWith(messageId);
      else expect(markRead).not.toHaveBeenCalled();
      const receipt = readFile(
        path.join(directory, `${key}.11111111-1111-4111-8111-111111111111.read`),
        'utf8'
      );
      if (fail) {
        expect(result.isError).toBe(true);
        await expect(receipt).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(result.isError).not.toBe(true);
        expect(await receipt).toBe('11111111-1111-4111-8111-111111111111');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
