import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerAgentCommands } from './agent.js';

function createHarness() {
  const agentRelay = {
    agents: {
      me: vi.fn(async () => ({ id: 'agent_1', name: 'room-human' })),
      presence: vi.fn(async () => [{ agent: 'room-human', status: 'online' }]),
    },
  };
  const createAgentRelay = vi.fn(() => agentRelay);
  const createWorkspaceRelay = vi.fn();
  const program = new Command();
  program.exitOverride();
  registerAgentCommands(program, {
    createAgentRelay: createAgentRelay as never,
    createWorkspaceRelay: createWorkspaceRelay as never,
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never,
  });
  return { program, agentRelay, createAgentRelay, createWorkspaceRelay };
}

describe('agent-scoped identity commands', () => {
  it.each([
    ['me', 'me'],
    ['presence', 'presence'],
  ] as const)('uses the agent credential for agent %s', async (command, method) => {
    const { program, agentRelay, createAgentRelay, createWorkspaceRelay } = createHarness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'agent',
      command,
      '--token',
      'at_live_room_human',
      '--workspace-key',
      'rk_live_owner_must_not_win',
      '--base-url',
      'https://cast.agentrelay.test',
    ]);

    expect(createAgentRelay).toHaveBeenCalledWith({
      token: 'at_live_room_human',
      workspaceKey: 'rk_live_owner_must_not_win',
      baseUrl: 'https://cast.agentrelay.test',
    });
    expect(createWorkspaceRelay).not.toHaveBeenCalled();
    expect(agentRelay.agents[method]).toHaveBeenCalledTimes(1);
  });
});
