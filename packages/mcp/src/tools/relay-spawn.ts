import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

/**
 * Supported CLI tools for spawning workers.
 * This list should be kept in sync with CliType in packages/wrapper/src/shared.ts
 * Note: 'cursor', 'spawned', 'other' are excluded as they're not valid spawn targets.
 */
export const SPAWNABLE_CLIS = ['claude', 'codex', 'gemini', 'droid', 'opencode'] as const;
export type SpawnableCli = typeof SPAWNABLE_CLIS[number];

export const relaySpawnSchema = z.object({
  name: z.string().describe('Unique name for the worker agent'),
  cli: z.enum(SPAWNABLE_CLIS).describe(
    'CLI tool to use for the worker (claude, codex, gemini, droid, opencode)'
  ),
  task: z.string().describe('Task description/prompt for the worker'),
  model: z.string().optional().describe('Model override (e.g., "claude-3-5-sonnet")'),
  cwd: z.string().optional().describe('Working directory for the worker'),
});

export type RelaySpawnInput = z.infer<typeof relaySpawnSchema>;

export const relaySpawnTool: Tool = {
  name: 'relay_spawn',
  description: `Spawn a worker agent to handle a subtask.

The worker runs in a separate process with its own CLI instance.
You'll receive a confirmation when the worker is ready.

Example:
  name="TestRunner"
  cli="claude"
  task="Run the test suite and report failures"`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Unique name for the worker agent',
      },
      cli: {
        type: 'string',
        enum: SPAWNABLE_CLIS as unknown as string[],
        description: 'CLI tool to use (claude, codex, gemini, droid, opencode)',
      },
      task: {
        type: 'string',
        description: 'Task description for the worker',
      },
      model: {
        type: 'string',
        description: 'Optional model override',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the worker',
      },
    },
    required: ['name', 'cli', 'task'],
  },
};

/**
 * Spawn a worker agent using the relay client.
 */
export async function handleRelaySpawn(
  client: RelayClient,
  input: RelaySpawnInput
): Promise<string> {
  const { name, cli, task, model, cwd } = input;

  const result = await client.spawn({
    name,
    cli,
    task,
    model,
    cwd,
  });

  if (result.success) {
    return `Worker "${name}" spawned successfully. It will message you when ready.`;
  } else {
    return `Failed to spawn worker: ${result.error}`;
  }
}
