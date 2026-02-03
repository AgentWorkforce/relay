import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client.js';

export const relaySendSchema = z.object({
  to: z.string().describe('Target: agent name, #channel, or * for broadcast'),
  message: z.string().describe('Message content'),
  thread: z.string().optional().describe('Optional thread ID for threaded conversations'),
  await_response: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, wait for a response (blocks until reply or timeout)'),
  timeout_ms: z
    .number()
    .optional()
    .default(30000)
    .describe('Timeout in milliseconds when await_response is true'),
});

export type RelaySendInput = z.infer<typeof relaySendSchema>;

export const relaySendTool: Tool = {
  name: 'relay_send',
  description: `Send a message via Agent Relay.

Examples:
- Direct message: to="Alice", message="Hello"
- Channel: to="#general", message="Team update"
- Broadcast: to="*", message="System notice"
- Threaded: to="Bob", message="Follow up", thread="task-123"
- Await reply: to="Worker", message="Process this", await_response=true`,
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Target: agent name, #channel, or * for broadcast',
      },
      message: {
        type: 'string',
        description: 'Message content',
      },
      thread: {
        type: 'string',
        description: 'Optional thread ID for threaded conversations',
      },
      await_response: {
        type: 'boolean',
        description: 'If true, wait for a response',
        default: false,
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in ms when await_response is true',
        default: 30000,
      },
    },
    required: ['to', 'message'],
  },
};

/**
 * Send a message via the relay daemon, optionally waiting for a response.
 */
export async function handleRelaySend(
  client: RelayClient,
  input: RelaySendInput
): Promise<string> {
  const { to, message, thread, await_response, timeout_ms } = input;

  if (await_response) {
    const ack = await client.sendAndWait(to, message, {
      thread,
      timeoutMs: timeout_ms,
    });
    // Extract response from AckPayload
    const responseText = ack.response || ack.responseData ? String(ack.responseData || ack.response) : 'OK';
    return `Response from ${to}: ${responseText}`;
  }

  await client.send(to, message, { thread });
  return `Message sent to ${to}`;
}
