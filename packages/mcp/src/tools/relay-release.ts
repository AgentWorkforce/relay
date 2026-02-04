import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

export const relayReleaseSchema = z.object({
  name: z.string().describe('Name of the worker to release'),
  reason: z.string().optional().describe('Optional reason for release'),
});

export type RelayReleaseInput = z.infer<typeof relayReleaseSchema>;

export const relayReleaseTool: Tool = {
  name: 'relay_release',
  description: `Release (terminate) a worker agent.

Use this when a worker has completed its task or is no longer needed.
The worker will be gracefully terminated.

Example:
  name="TestRunner"
  reason="Tests completed successfully"`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the worker to release',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for release',
      },
    },
    required: ['name'],
  },
};

/**
 * Release a worker agent via the relay client.
 */
export async function handleRelayRelease(
  client: RelayClient,
  input: RelayReleaseInput
): Promise<string> {
  const { name, reason } = input;

  const result = await client.release(name, reason);

  if (result.success) {
    return `Worker "${name}" released.`;
  } else {
    return `Failed to release worker: ${result.error}`;
  }
}
