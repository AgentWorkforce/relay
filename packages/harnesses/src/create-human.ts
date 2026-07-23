import type { AgentRelay, RelayAgentClient } from '@agent-relay/sdk';

export interface CreateHumanInput {
  relay: AgentRelay;
  name: string;
  persona?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Register a human participant and return their live client.
 *
 * A human is just a harness with no managed runtime, so `createHuman({ relay })`
 * self-registers and returns the live client — mirroring `claude.create({ relay })`.
 */
export function createHuman(input: CreateHumanInput): Promise<RelayAgentClient> {
  const { relay, name, persona, metadata } = input;
  return relay.workspace.register({ name, type: 'human', persona, metadata });
}
