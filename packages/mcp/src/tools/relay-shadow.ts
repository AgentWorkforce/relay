/**
 * relay_shadow_bind / relay_shadow_unbind - Shadow agent operations
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

// Bind as shadow
export const relayShadowBindSchema = z.object({
  primary_agent: z.string().describe('The name of the primary agent to shadow'),
  speak_on: z.array(z.string()).optional().describe('Events that trigger the shadow to speak (e.g., ["SESSION_END", "CODE_WRITTEN"])'),
});

export type RelayShadowBindInput = z.infer<typeof relayShadowBindSchema>;

export const relayShadowBindTool: Tool = {
  name: 'relay_shadow_bind',
  description: 'Bind as a shadow agent to monitor another agent. Shadows can observe and optionally respond to specific events.',
  inputSchema: {
    type: 'object',
    properties: {
      primary_agent: { type: 'string', description: 'The name of the primary agent to shadow' },
      speak_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Events that trigger the shadow to speak (e.g., ["SESSION_END", "CODE_WRITTEN", "REVIEW_REQUEST"])',
      },
    },
    required: ['primary_agent'],
  },
};

export async function handleRelayShadowBind(client: RelayClient, input: RelayShadowBindInput): Promise<string> {
  const result = await client.bindAsShadow(input.primary_agent, { speakOn: input.speak_on });
  if (result.success) {
    return `Now shadowing agent "${input.primary_agent}"`;
  }
  return `Failed to bind as shadow: ${result.error}`;
}

// Unbind from shadow
export const relayShadowUnbindSchema = z.object({
  primary_agent: z.string().describe('The name of the primary agent to stop shadowing'),
});

export type RelayShadowUnbindInput = z.infer<typeof relayShadowUnbindSchema>;

export const relayShadowUnbindTool: Tool = {
  name: 'relay_shadow_unbind',
  description: 'Stop shadowing an agent.',
  inputSchema: {
    type: 'object',
    properties: {
      primary_agent: { type: 'string', description: 'The name of the primary agent to stop shadowing' },
    },
    required: ['primary_agent'],
  },
};

export async function handleRelayShadowUnbind(client: RelayClient, input: RelayShadowUnbindInput): Promise<string> {
  const result = await client.unbindAsShadow(input.primary_agent);
  if (result.success) {
    return `Stopped shadowing agent "${input.primary_agent}"`;
  }
  return `Failed to unbind from shadow: ${result.error}`;
}
