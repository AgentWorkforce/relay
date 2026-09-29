import { expect, test } from 'vitest';

import { registerMessagingTools } from '../packages/cli/src/cli/mcp/messaging-tools.js';

type ToolHandler = (input: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>;

class ProbeServer {
  readonly tools = new Map<string, ToolHandler>();

  registerTool(name: string, _config: unknown, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }
}

test('one logical MCP send creates one upstream direct message across server retries', async () => {
  const idempotencyKey = 'relayflow-1866-lost-response';
  const created: Array<{ id: string; key?: string }> = [];
  const byKey = new Map<string, { id: string }>();

  const runInFreshMcpServer = async (requestId: number) => {
    const server = new ProbeServer();
    const client = {
      dm: async (_to: string, _text: string, options?: { idempotencyKey?: string }) => {
        const key = options?.idempotencyKey;
        if (key && byKey.has(key)) return byKey.get(key);
        const message = { id: `message-${created.length + 1}` };
        created.push({ id: message.id, key });
        if (key) byKey.set(key, message);
        return message;
      },
    };
    const processLocalReplay = {
      run: async (_tool: string, _extra: unknown, _key: string | undefined, effect: () => Promise<unknown>) =>
        effect(),
    };
    registerMessagingTools(server as never, () => client as never, undefined, processLocalReplay as never);
    await server.tools.get('send_dm')?.(
      {
        to: 'relayflow-recipient',
        text: 'one logical message',
        idempotency_key: idempotencyKey,
      },
      { sessionId: `fresh-server-${requestId}`, requestId }
    );
  };

  await runInFreshMcpServer(1);
  await runInFreshMcpServer(2);

  const expectedCount = process.env.RELAY_PR_PROOF_ARM === 'base' ? 2 : 1;
  expect(created).toHaveLength(expectedCount);
  if (expectedCount === 1) expect(created[0].key).toBe(idempotencyKey);
});
