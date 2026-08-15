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
    agents: {
      get: vi.fn(async (name: string) => ({ id: 'agent_existing', name, status: 'online' })),
    },
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

  it('register --strict fails on a name conflict instead of rotating', async () => {
    const { program, workspaceRelay } = createHarness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'agent',
      'register',
      'chief',
      '--strict',
      '--workspace-key',
      'rk_live_test',
    ]);

    expect(workspaceRelay.workspace.register).toHaveBeenCalledWith(
      { name: 'chief', type: undefined, persona: undefined },
      { strict: true }
    );
  });

  it('register surfaces the bounded-registration timeout instead of hanging on a broken existing name', async () => {
    const { program, workspaceRelay, error } = createHarness();
    workspaceRelay.workspace.register.mockReturnValueOnce(new Promise(() => {}));

    vi.useFakeTimers();
    try {
      const run = program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'register',
        'chief',
        '--workspace-key',
        'rk_live_test',
      ]);
      const assertion = expect(run).rejects.toThrow('exit:1');
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    const rendered = error.mock.calls.flat().join('\n');
    expect(rendered).toContain('did not complete within 15000ms');
    expect(rendered).toContain('agent rotate');
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

    expect(workspaceRelay.agents.get).toHaveBeenCalledWith('chief');
    expect(workspaceRelay.workspace.register).toHaveBeenCalledWith({ name: 'chief' });
  });

  it('rejects rotation of a name that does not already exist instead of minting a new identity', async () => {
    const { program, workspaceRelay, error } = createHarness();
    workspaceRelay.agents.get.mockRejectedValueOnce(
      Object.assign(new Error('Agent "ghost" not found'), { statusCode: 404 })
    );

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'rotate',
        'ghost',
        '--workspace-key',
        'rk_live_test',
      ])
    ).rejects.toThrow('exit:1');

    expect(workspaceRelay.workspace.register).not.toHaveBeenCalled();
    const rendered = error.mock.calls.flat().join('\n');
    expect(rendered).toContain('does not exist');
    expect(rendered).toContain('agent register');
  });

  it('rethrows a non-404 existence-check failure unchanged instead of claiming the agent does not exist', async () => {
    // A network/auth/5xx failure means "unknown", not "does not exist" —
    // translating it to the latter would point the caller at `agent
    // register` (create-or-rotate), which would rotate and disconnect a
    // still-valid token for an identity that does exist but was merely
    // unreachable.
    const { program, workspaceRelay, error } = createHarness();
    workspaceRelay.agents.get.mockRejectedValueOnce(new Error('upstream connection reset'));

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'rotate',
        'chief',
        '--workspace-key',
        'rk_live_test',
      ])
    ).rejects.toThrow('exit:1');

    expect(workspaceRelay.workspace.register).not.toHaveBeenCalled();
    const rendered = error.mock.calls.flat().join('\n');
    expect(rendered).toContain('upstream connection reset');
    expect(rendered).not.toContain('does not exist');
  });

  it('bounds the rotate existence check so a hung agents.get cannot hang the command', async () => {
    const { program, workspaceRelay, error } = createHarness();
    workspaceRelay.agents.get.mockReturnValueOnce(new Promise(() => {}));

    vi.useFakeTimers();
    try {
      const run = program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'rotate',
        'chief',
        '--workspace-key',
        'rk_live_test',
      ]);
      const assertion = expect(run).rejects.toThrow('exit:1');
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(workspaceRelay.workspace.register).not.toHaveBeenCalled();
    const rendered = error.mock.calls.flat().join('\n');
    expect(rendered).toContain('did not complete within 15000ms');
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

  it('reports removal as initiated, not completed, when the release invocation is still pending', async () => {
    const { program, workspaceRelay, log } = createHarness();
    workspaceRelay.workspace.release.mockResolvedValueOnce({ status: 'dispatched' });

    await program.parseAsync([
      'node',
      'agent-relay',
      'agent',
      'remove',
      'chief-dmcheck-1536',
      '--workspace-key',
      'rk_live_test',
    ]);

    const rendered = log.mock.calls.flat().join('\n');
    expect(rendered).toContain('initiated');
    expect(rendered).not.toContain('Removed agent');
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
