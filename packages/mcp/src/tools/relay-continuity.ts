import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client.js';

export const relayContinuitySchema = z.object({
  action: z.enum(['save', 'load', 'uncertain']).describe('Action: save state, load previous state, or mark uncertainty'),
  current_task: z.string().optional().describe('Current task being worked on (for save)'),
  completed: z.string().optional().describe('Completed work summary (for save)'),
  in_progress: z.string().optional().describe('In-progress work summary (for save)'),
  key_decisions: z.string().optional().describe('Key decisions made (for save)'),
  files: z.string().optional().describe('Files being worked on (for save)'),
  item: z.string().optional().describe('Item to mark as uncertain (for uncertain action)'),
});

export type RelayContinuityInput = z.infer<typeof relayContinuitySchema>;

export const relayContinuityTool: Tool = {
  name: 'relay_continuity',
  description: `Manage session continuity for agent recovery.

Use this to:
- Save your current state before long operations or session end
- Load previous context when starting a new session
- Mark items that need future verification

Examples:
- Save state: action="save", current_task="Implementing auth", completed="User model done"
- Load state: action="load"
- Mark uncertain: action="uncertain", item="API rate limit handling unclear"`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'load', 'uncertain'],
        description: 'Action: save state, load previous state, or mark uncertainty',
      },
      current_task: {
        type: 'string',
        description: 'Current task being worked on (for save)',
      },
      completed: {
        type: 'string',
        description: 'Completed work summary (for save)',
      },
      in_progress: {
        type: 'string',
        description: 'In-progress work summary (for save)',
      },
      key_decisions: {
        type: 'string',
        description: 'Key decisions made (for save)',
      },
      files: {
        type: 'string',
        description: 'Files being worked on (for save)',
      },
      item: {
        type: 'string',
        description: 'Item to mark as uncertain (for uncertain action)',
      },
    },
    required: ['action'],
  },
};

// Extended client interface for continuity features
interface ExtendedRelayClient extends RelayClient {
  saveContinuity?: (state: {
    currentTask?: string;
    completed?: string;
    inProgress?: string;
    keyDecisions?: string;
    files?: string;
  }) => Promise<void>;
  loadContinuity?: () => Promise<void>;
  markUncertain?: (item: string) => Promise<void>;
}

/**
 * Handle continuity actions for session recovery.
 */
export async function handleRelayContinuity(
  client: RelayClient,
  input: RelayContinuityInput
): Promise<string> {
  const extClient = client as ExtendedRelayClient;
  const { action, current_task, completed, in_progress, key_decisions, files, item } = input;

  switch (action) {
    case 'save': {
      if (!extClient.saveContinuity) {
        return 'Continuity save not supported by this client';
      }
      await extClient.saveContinuity({
        currentTask: current_task,
        completed,
        inProgress: in_progress,
        keyDecisions: key_decisions,
        files,
      });
      return 'Session state saved for recovery';
    }

    case 'load': {
      if (!extClient.loadContinuity) {
        return 'Continuity load not supported by this client';
      }
      await extClient.loadContinuity();
      return 'Previous session context loaded';
    }

    case 'uncertain': {
      if (!extClient.markUncertain) {
        return 'Mark uncertain not supported by this client';
      }
      if (!item) {
        return 'Item required for uncertain action';
      }
      await extClient.markUncertain(item);
      return `Marked as uncertain: ${item}`;
    }

    default:
      return `Unknown action: ${action}`;
  }
}
