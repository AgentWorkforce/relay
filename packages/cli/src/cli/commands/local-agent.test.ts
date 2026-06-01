import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

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
  const group = program.command('driver');
  registerLocalAgentCommands(group, deps);
  return { program, client, attach, log, error, exit };
}

describe('runtime agent subtree', () => {
  it('attach --mode dispatches to the attach runner', async () => {
    const { program, attach } = harness();
    await program.parseAsync(['driver', 'agent', 'attach', 'lead', '--mode', 'view'], { from: 'user' });
    expect(attach).toHaveBeenCalledWith('lead', 'view', expect.objectContaining({}));
  });

  it('attach defaults to view mode', async () => {
    const { program, attach } = harness();
    await program.parseAsync(['driver', 'agent', 'attach', 'lead'], { from: 'user' });
    expect(attach).toHaveBeenCalledWith('lead', 'view', expect.anything());
  });

  it('attach rejects an unknown mode', async () => {
    const { program, attach, error, exit } = harness();
    await program.parseAsync(['driver', 'agent', 'attach', 'lead', '--mode', 'bogus'], { from: 'user' });
    expect(attach).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown attach mode'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('list queries the broker', async () => {
    const { program, client } = harness();
    await program.parseAsync(['driver', 'agent', 'list'], { from: 'user' });
    expect(client.listAgents).toHaveBeenCalled();
  });

  it('release calls client.release', async () => {
    const { program, client } = harness();
    await program.parseAsync(['driver', 'agent', 'release', 'lead'], { from: 'user' });
    expect(client.release).toHaveBeenCalledWith('lead');
  });

  it('release --kill hard-kills via client.release', async () => {
    const { program, client } = harness();
    await program.parseAsync(['driver', 'agent', 'release', 'lead', '--kill'], { from: 'user' });
    expect(client.release).toHaveBeenCalledWith('lead', 'kill');
  });

  it('set-model forwards name and model to client.setModel', async () => {
    const { program, client } = harness();
    await program.parseAsync(['driver', 'agent', 'set-model', 'lead', 'opus'], { from: 'user' });
    expect(client.setModel).toHaveBeenCalledWith('lead', 'opus');
  });
});
