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
  const workspaceRelay = {
    workspace: {
      register: vi.fn(async ({ name }: { name: string }) => ({
        id: 'agent_rotated',
        name,
        token: 'at_live_rotated',
      })),
      release: vi.fn(async () => ({ status: 'completed' })),
    },
  };
  const createAgentRelay = vi.fn(() => agentRelay);
  const createWorkspaceRelay = vi.fn(() => workspaceRelay);
  const log = vi.fn();
  const error = vi.fn();
  const program = new Command();
  program.exitOverride();
  registerAgentCommands(program, {
    createAgentRelay: createAgentRelay as never,
    createWorkspaceRelay: createWorkspaceRelay as never,
    log,
    error,
    exit: ((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never,
  });
  return {
    program,
    agentRelay,
    workspaceRelay,
    createAgentRelay,
    createWorkspaceRelay,
    log,
    error,
  };
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

describe('agent identity lifecycle commands', () => {
  it('register adopts an existing name by rotating its token', async () => {
    const { program, workspaceRelay, log } = createHarness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'agent',
      'register',
      'chief',
      '--workspace-key',
      'rk_live_test',
    ]);

    expect(workspaceRelay.workspace.register).toHaveBeenCalledWith(
      { name: 'chief', type: undefined, persona: undefined },
      { strict: false }
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      id: 'agent_rotated',
      name: 'chief',
      token: 'at_live_rotated',
    });
  });

  it('exposes an explicit token rotation command for an existing name', async () => {
    const { program, workspaceRelay } = createHarness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'agent',
      'rotate',
      'chief',
      '--workspace-key',
      'rk_live_test',
    ]);

    expect(workspaceRelay.workspace.register).toHaveBeenCalledWith({ name: 'chief' });
  });

  it('removes through the lifecycle endpoint with a reason and actor', async () => {
    const { program, workspaceRelay } = createHarness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'agent',
      'remove',
      'chief-dmcheck-1536',
      '--reason',
      'test cleanup',
      '--workspace-key',
      'rk_live_test',
    ]);

    expect(workspaceRelay.workspace.release).toHaveBeenCalledWith({
      name: 'chief-dmcheck-1536',
      reason: expect.stringMatching(/^test cleanup \(actor: .+\)$/),
      deleteAgent: true,
    });
  });

  it('redacts SQL and bound parameters when removal fails', async () => {
    const { program, workspaceRelay, error } = createHarness();
    workspaceRelay.workspace.release.mockRejectedValueOnce(
      new Error('Failed query: delete from "agents" where "agents"."id" = ?\nparams: 214015171589668864')
    );

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'remove',
        'chief-dmcheck-1536',
        '--workspace-key',
        'rk_live_test',
      ])
    ).rejects.toThrow('exit:1');

    const rendered = error.mock.calls.flat().join('\n');
    expect(rendered).toContain('Relay service could not complete the request');
    expect(rendered).not.toContain('delete from');
    expect(rendered).not.toContain('params:');
    expect(rendered).not.toContain('214015171589668864');
  });
});
