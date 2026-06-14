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
    spawnPty: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    setModel: vi.fn(async () => ({ name: 'lead', model: 'opus', success: true })),
    flushPending: vi.fn(async () => ({ flushed: 2 })),
    setInboundDeliveryMode: vi.fn(async (_name: string, mode: string) => ({ mode, flushed: 0 })),
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

  it('spawn forwards task-exit lifecycle options', async () => {
    const { program, client } = harness();
    await program.parseAsync(
      [
        'local',
        'agent',
        'spawn',
        'codex',
        '--name',
        'WorkerA',
        '--task',
        'Ship it',
        '--spawn-mode',
        'task-exit',
        '--exit-after-task',
      ],
      { from: 'user' }
    );

    expect(client.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'WorkerA',
        cli: 'codex',
        task: 'Ship it',
        spawnMode: 'task_exit',
        exitAfterTask: true,
      })
    );
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

  it('message flush drains a local broker agent queue', async () => {
    const client = { flushPending: vi.fn(async () => ({ flushed: 2 })) };
    const connectLocal = vi.fn(async () => client as never);
    const { program, log } = harness({ connectLocal });

    await program.parseAsync(
      [
        'local',
        'agent',
        'message',
        'flush',
        'claude',
        '--broker-url',
        'http://127.0.0.1:3890',
        '--api-key',
        'secret',
        '--state-dir',
        '/tmp/relay-state',
      ],
      { from: 'user' }
    );

    expect(connectLocal).toHaveBeenCalledWith('/tmp/project', {
      brokerUrl: 'http://127.0.0.1:3890',
      apiKey: 'secret',
      stateDir: '/tmp/relay-state',
    });
    expect(client.flushPending).toHaveBeenCalledWith('claude');
    expect(log).toHaveBeenCalledWith(JSON.stringify({ name: 'claude', flushed: 2 }, null, 2));
  });

  it('message hold and auto switch local broker delivery mode', async () => {
    const client = {
      setInboundDeliveryMode: vi.fn(async (_name: string, mode: string) => ({ mode, flushed: 0 })),
    };
    const connectLocal = vi.fn(async () => client as never);
    const { program, log } = harness({ connectLocal });

    await program.parseAsync(['local', 'agent', 'message', 'hold', 'claude'], { from: 'user' });
    await program.parseAsync(['local', 'agent', 'message', 'auto', 'claude'], { from: 'user' });

    expect(connectLocal).toHaveBeenNthCalledWith(1, '/tmp/project', {
      brokerUrl: undefined,
      apiKey: undefined,
      stateDir: undefined,
    });
    expect(connectLocal).toHaveBeenNthCalledWith(2, '/tmp/project', {
      brokerUrl: undefined,
      apiKey: undefined,
      stateDir: undefined,
    });
    expect(client.setInboundDeliveryMode).toHaveBeenNthCalledWith(1, 'claude', 'manual_flush');
    expect(client.setInboundDeliveryMode).toHaveBeenNthCalledWith(2, 'claude', 'auto_inject');
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ name: 'claude', mode: 'manual_flush', flushed: 0 }, null, 2)
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ name: 'claude', mode: 'auto_inject', flushed: 0 }, null, 2)
    );
  });
});
