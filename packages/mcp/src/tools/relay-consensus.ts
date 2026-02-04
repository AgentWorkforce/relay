/**
 * relay_proposal / relay_vote - Consensus/voting operations
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

// Create proposal
export const relayProposalSchema = z.object({
  id: z.string().describe('Unique identifier for the proposal'),
  description: z.string().describe('Description of what is being proposed'),
  options: z.array(z.string()).describe('List of voting options'),
  voting_method: z.enum(['majority', 'supermajority', 'unanimous', 'weighted', 'quorum']).optional()
    .describe('Voting method (default: majority)'),
  deadline: z.number().optional().describe('Optional deadline timestamp in milliseconds'),
});

export type RelayProposalInput = z.infer<typeof relayProposalSchema>;

export const relayProposalTool: Tool = {
  name: 'relay_proposal',
  description: 'Create a new proposal for agents to vote on. Use this to coordinate decisions among multiple agents.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Unique identifier for the proposal' },
      description: { type: 'string', description: 'Description of what is being proposed' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of voting options',
      },
      voting_method: {
        type: 'string',
        enum: ['majority', 'supermajority', 'unanimous', 'weighted', 'quorum'],
        description: 'Voting method (default: majority)',
      },
      deadline: { type: 'number', description: 'Optional deadline timestamp in milliseconds' },
    },
    required: ['id', 'description', 'options'],
  },
};

export async function handleRelayProposal(client: RelayClient, input: RelayProposalInput): Promise<string> {
  const result = await client.createProposal({
    id: input.id,
    description: input.description,
    options: input.options,
    votingMethod: input.voting_method,
    deadline: input.deadline,
  });
  if (result.success) {
    return `Proposal "${input.id}" created successfully. Options: ${input.options.join(', ')}`;
  }
  return `Failed to create proposal: ${result.error}`;
}

// Vote on proposal
export const relayVoteSchema = z.object({
  proposal_id: z.string().describe('The ID of the proposal to vote on'),
  vote: z.string().describe('Your vote (must be one of the proposal options, or "approve"/"reject"/"abstain")'),
  reason: z.string().optional().describe('Optional reason for your vote'),
});

export type RelayVoteInput = z.infer<typeof relayVoteSchema>;

export const relayVoteTool: Tool = {
  name: 'relay_vote',
  description: 'Cast a vote on an existing proposal.',
  inputSchema: {
    type: 'object',
    properties: {
      proposal_id: { type: 'string', description: 'The ID of the proposal to vote on' },
      vote: { type: 'string', description: 'Your vote (must be one of the proposal options, or "approve"/"reject"/"abstain")' },
      reason: { type: 'string', description: 'Optional reason for your vote' },
    },
    required: ['proposal_id', 'vote'],
  },
};

export async function handleRelayVote(client: RelayClient, input: RelayVoteInput): Promise<string> {
  const result = await client.vote({
    proposalId: input.proposal_id,
    vote: input.vote,
    reason: input.reason,
  });
  if (result.success) {
    return `Vote "${input.vote}" cast on proposal "${input.proposal_id}"`;
  }
  return `Failed to vote: ${result.error}`;
}
