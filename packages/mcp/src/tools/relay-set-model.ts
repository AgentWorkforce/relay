import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

export const relaySetModelSchema = z.object({
  name: z.string().describe('Name of the worker agent to change model for'),
  model: z.string().describe('Target model (e.g., "opus", "sonnet", "haiku")'),
  timeout_ms: z.number().optional().describe('Max time (ms) to wait for agent to become idle (default: 30000)'),
});

export type RelaySetModelInput = z.infer<typeof relaySetModelSchema>;

export const relaySetModelTool: Tool = {
  name: 'relay_set_model',
  description: `Change the model of a running worker agent.

Waits for the agent to be idle (not mid-generation), then sends the model switch command.
Currently supported for Claude Code agents only (opus, sonnet, haiku).

Example:
  name="Worker1"
  model="opus"`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the worker agent',
      },
      model: {
        type: 'string',
        description: 'Target model (e.g., "opus", "sonnet", "haiku")',
      },
      timeout_ms: {
        type: 'number',
        description: 'Max wait time for agent idle (ms, default: 30000)',
      },
    },
    required: ['name', 'model'],
  },
};

/**
 * Change the model of a running worker agent.
 */
export async function handleRelaySetModel(
  client: RelayClient,
  input: RelaySetModelInput,
): Promise<string> {
  const { name, model, timeout_ms } = input;

  const result = await client.setModel(name, model, {
    timeoutMs: timeout_ms,
  });

  if (result.success) {
    const prev = result.previousModel ? ` (was: ${result.previousModel})` : '';
    return `Model for "${name}" switched to "${model}"${prev}.`;
  } else {
    return `Failed to switch model for "${name}": ${result.error}`;
  }
}
