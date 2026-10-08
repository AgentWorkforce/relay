import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerAgentCommands } from './agent.js';

function createHarness(env: NodeJS.ProcessEnv = {}) {
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
    env,
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

function nameConflict(name: string): Error {
  return Object.assign(new Error(`Agent "${name}" already exists in this workspace`), {
    code: 'name_conflict',
    statusCode: 409,
  });
}

function helpFor(program: Command, ...names: string[]): string {
  let command: Command | undefined = program;
  for (const name of names) command = command?.commands.find((candidate) => candidate.name() === name);
  if (!command) throw new Error(`no command ${names.join(' ')}`);
  let rendered = '';
  command.configureOutput({ writeOut: (text) => (rendered += text) });
  command.outputHelp();
  return rendered;
}

function everythingPrinted(harness: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }) {
  return [...harness.log.mock.calls, ...harness.error.mock.calls].flat().map(String).join('\n');
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
  it('register is create-only: a new name is registered without the rotation path', async () => {
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

    expect(workspaceRelay.workspace.register).toHaveBeenCalledTimes(1);
    expect(workspaceRelay.workspace.register).toHaveBeenCalledWith(
      { name: 'chief', type: undefined, persona: undefined },
      { strict: true }
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      id: 'agent_rotated',
      name: 'chief',
      token: 'at_live_rotated',
    });
  });

  it('register refuses to rotate an existing name without --rotate and explains why', async () => {
    const harness = createHarness();
    harness.workspaceRelay.workspace.register.mockRejectedValueOnce(nameConflict('chief'));

    await expect(
      harness.program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'register',
        'chief',
        '--workspace-key',
        'rk_live_test',
      ])
    ).rejects.toThrow('exit:1');

    // Exactly one create-only attempt; the rotating path is never reached.
    expect(harness.workspaceRelay.workspace.register).toHaveBeenCalledTimes(1);
    expect(harness.workspaceRelay.workspace.register).toHaveBeenCalledWith(expect.anything(), {
      strict: true,
    });
    const rendered = everythingPrinted(harness);
    expect(rendered).toContain('already exists');
    expect(rendered).toContain('left its token unchanged');
    expect(rendered).toContain('RELAY_AGENT_TOKEN');
    expect(rendered).toContain('desktop session socket');
    expect(rendered).toContain('--rotate');
    expect(rendered).not.toContain('at_live_');
  });

  it("register refuses to rotate this session's own identity without --rotate", async () => {
    const harness = createHarness({ RELAY_AGENT_NAME: 'Chief' });
    harness.workspaceRelay.workspace.register.mockRejectedValueOnce(nameConflict('chief'));

    await expect(
      harness.program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'register',
        'chief',
        '--wk',
        'rk_live_test',
      ])
    ).rejects.toThrow('exit:1');

    expect(harness.workspaceRelay.workspace.register).toHaveBeenCalledTimes(1);
    expect(everythingPrinted(harness)).toContain('do not re-register its name');
  });

  it('register --rotate rotates an existing name only when asked', async () => {
    const harness = createHarness();
    harness.workspaceRelay.workspace.register.mockRejectedValueOnce(nameConflict('chief'));

    await harness.program.parseAsync([
      'node',
      'agent-relay',
      'agent',
      'register',
      'chief',
      '--rotate',
      '--workspace-key',
      'rk_live_test',
    ]);

    expect(harness.workspaceRelay.workspace.register).toHaveBeenNthCalledWith(1, expect.anything(), {
      strict: true,
    });
    expect(harness.workspaceRelay.workspace.register).toHaveBeenNthCalledWith(2, expect.anything(), {
      strict: false,
    });
    expect(JSON.parse(String(harness.log.mock.calls[0]?.[0]))).toMatchObject({ name: 'chief' });
  });

  it("register --rotate warns before rotating this session's own identity", async () => {
    const harness = createHarness({ RELAY_AGENT_NAME: 'chief' });
    harness.workspaceRelay.workspace.register.mockRejectedValueOnce(nameConflict('chief'));

    await harness.program.parseAsync([
      'node',
      'agent-relay',
      'agent',
      'register',
      'chief',
      '--rotate',
      '--workspace-key',
      'rk_live_test',
    ]);

    expect(harness.error.mock.calls.flat().join('\n')).toContain("this session's own identity");
  });

  it('register --rotate reports a create-only server refusal without claiming a rotation', async () => {
    const harness = createHarness();
    harness.workspaceRelay.workspace.register
      .mockRejectedValueOnce(nameConflict('chief'))
      .mockRejectedValueOnce(nameConflict('chief'));

    await expect(
      harness.program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'register',
        'chief',
        '--rotate',
        '--workspace-key',
        'rk_live_test',
      ])
    ).rejects.toThrow('exit:1');

    const rendered = everythingPrinted(harness);
    expect(rendered).toContain('refused to rotate');
    expect(rendered).toContain('left unchanged');
  });

  it('register --strict stays accepted as a deprecated create-only alias', async () => {
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

  it('register rejects --strict combined with --rotate', async () => {
    const harness = createHarness();

    await expect(
      harness.program.parseAsync([
        'node',
        'agent-relay',
        'agent',
        'register',
        'chief',
        '--strict',
        '--rotate',
        '--workspace-key',
        'rk_live_test',
      ])
    ).rejects.toThrow('exit:1');
    expect(harness.workspaceRelay.workspace.register).not.toHaveBeenCalled();
  });

  it('register help states create-only, the explicit --rotate flag, and the non-rotating alternatives', () => {
    const { program } = createHarness();
    const help = helpFor(program, 'agent', 'register');

    expect(help).toContain('Create-only');
    expect(help).toContain('--rotate');
    expect(help).toContain('never re-register its name');
    expect(help).not.toContain('--strict');
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
