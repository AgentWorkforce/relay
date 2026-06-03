import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

const harnessConnectMock = vi.hoisted(() => vi.fn());

vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: {
    connect: harnessConnectMock,
  },
}));

import { registerLocalAgentCommands, type LocalAgentDependencies } from './local-agent.js';

function harness(overrides: Partial<LocalAgentDependencies> = {}) {
  const client = {
    listAgents: vi.fn(async () => [{ name: 'lead' }]),
    release: vi.fn(async () => undefined),
    setModel: vi.fn(async () => ({ name: 'lead', model: 'opus', success: true })),
  };
  const attach = vi.fn(async () => 0);
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  const deps: Partial<LocalAgentDependencies> = {
    connect: vi.fn(async () => client as never),
    attach,
    cwd: () => '/tmp/project',
    log,
    error,
    exit: exit as never,
    ...overrides,
  };
  const program = new Command();
  program.exitOverride();
  const group = program.command('local');
  registerLocalAgentCommands(group, deps);
  return { program, client, attach, log, error, exit };
}

describe('local agent subtree', () => {
  it('attach --mode dispatches to the attach runner', async () => {
    const { program, attach } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--mode', 'view'], { from: 'user' });
    expect(attach).toHaveBeenCalledWith('lead', 'view', expect.objectContaining({}));
  });

  it('attach defaults to view mode', async () => {
    const { program, attach } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead'], { from: 'user' });
    expect(attach).toHaveBeenCalledWith('lead', 'view', expect.anything());
  });

  it('attach rejects an unknown mode', async () => {
    const { program, attach, error, exit } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--mode', 'bogus'], { from: 'user' });
    expect(attach).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown attach mode'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('list queries the broker', async () => {
    const { program, client } = harness();
    await program.parseAsync(['local', 'agent', 'list'], { from: 'user' });
    expect(client.listAgents).toHaveBeenCalled();
  });

  it('list connects to the existing project broker instead of spawning one', async () => {
    const client = {
      listAgents: vi.fn(async () => []),
      disconnect: vi.fn(),
    };
    harnessConnectMock.mockReturnValueOnce(client);
    const log = vi.fn();
    const program = new Command();
    program.exitOverride();
    const group = program.command('local');
    registerLocalAgentCommands(group, {
      cwd: () => '/tmp/project',
      log,
    });

    await program.parseAsync(['local', 'agent', 'list'], { from: 'user' });

    expect(harnessConnectMock).toHaveBeenCalledWith({ cwd: '/tmp/project' });
    expect(client.listAgents).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[]');
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('release calls client.release', async () => {
    const { program, client } = harness();
    await program.parseAsync(['local', 'agent', 'release', 'lead'], { from: 'user' });
    expect(client.release).toHaveBeenCalledWith('lead');
  });

  it('set-model forwards name and model to client.setModel', async () => {
    const { program, client } = harness();
    await program.parseAsync(['local', 'agent', 'set-model', 'lead', 'opus'], { from: 'user' });
    expect(client.setModel).toHaveBeenCalledWith('lead', 'opus');
  });
});
