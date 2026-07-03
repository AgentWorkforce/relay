import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const brokerMocks = vi.hoisted(() => ({
  runUpCommand: vi.fn(async () => undefined),
  runDownCommand: vi.fn(async () => undefined),
  runStatusCommand: vi.fn(async () => undefined),
  readBrokerConnection: vi.fn(() => null),
}));

vi.mock('../lib/broker-lifecycle.js', () => ({
  runUpCommand: (...args: unknown[]) => brokerMocks.runUpCommand(...args),
  runDownCommand: (...args: unknown[]) => brokerMocks.runDownCommand(...args),
  runStatusCommand: (...args: unknown[]) => brokerMocks.runStatusCommand(...args),
  readBrokerConnection: (...args: unknown[]) => brokerMocks.readBrokerConnection(...args),
}));

import { registerNodeCommands, type NodeCommandDependencies } from './node.js';
import type { CoreDependencies } from './core.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const enrollmentRecord = {
  nodeId: 'node_abc',
  nodeName: 'kjglaptop',
  nodeToken: 'nt_secret',
  relayWorkspaceId: 'rw_123',
  relaycastUrl: 'https://relaycast.example.com',
  websocketUrl: 'https://relaycast.example.com/v1/node/ws',
  enrolledAt: '2026-07-03T00:00:00.000Z',
};

function createNodeHarness(opts?: {
  env?: NodeJS.ProcessEnv;
  resolveEnrollment?: NodeCommandDependencies['resolveEnrollment'];
}) {
  const env: NodeJS.ProcessEnv = opts?.env ?? {};
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as NodeCommandDependencies['exit'];
  const log = vi.fn();
  const error = vi.fn();
  const warn = vi.fn();

  const core = { env, exit, log, error, warn } as unknown as CoreDependencies;
  const resolveEnrollment =
    opts?.resolveEnrollment ??
    (vi.fn(() => undefined) as unknown as NodeCommandDependencies['resolveEnrollment']);

  const program = new Command();
  program.exitOverride();
  registerNodeCommands(program, { core, exit, log, error, warn, resolveEnrollment });

  return { program, env, log, error, exit, resolveEnrollment };
}

beforeEach(() => {
  brokerMocks.runUpCommand.mockClear();
  brokerMocks.runDownCommand.mockClear();
  brokerMocks.runStatusCommand.mockClear();
});

describe('registerNodeCommands', () => {
  it('registers the node command tree (up/down/status/metrics/agent/tail/workflow)', () => {
    const { program } = createNodeHarness();
    const node = program.commands.find((command) => command.name() === 'node')!;

    expect(node.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['up', 'down', 'status', 'metrics', 'agent', 'tail', 'workflow'])
    );

    const workflow = node.commands.find((command) => command.name() === 'workflow')!;
    expect(workflow.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['run', 'logs', 'sync'])
    );

    const agent = node.commands.find((command) => command.name() === 'agent')!;
    expect(agent.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['list', 'spawn', 'new', 'release', 'set-model', 'attach', 'message'])
    );

    const up = node.commands.find((command) => command.name() === 'up')!;
    expect(up.options.map((option) => option.long)).toContain('--config');
  });

  it('does not print the deprecated `local` warning when invoked as `node`', async () => {
    const { program } = createNodeHarness({ env: { RELAY_NODE_TOKEN: 'x' } });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await program.parseAsync(['node', 'up'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }

    expect(writes.join('')).not.toContain('deprecated');
  });

  it('picks up a persisted enrollment and wires its creds into the env', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env, log } = createNodeHarness({ env: {}, resolveEnrollment });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(resolveEnrollment).toHaveBeenCalledTimes(1);
    expect(env.RELAY_NODE_TOKEN).toBe('nt_secret');
    expect(env.RELAY_BASE_URL).toBe('https://relaycast.example.com');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join('\n')).toContain('kjglaptop');
    expect(log.mock.calls.flat().join('\n')).toContain('rw_123');
  });

  it('does not clobber an existing RELAY_NODE_TOKEN or query the store', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({
      env: { RELAY_NODE_TOKEN: 'preexisting' },
      resolveEnrollment,
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(resolveEnrollment).not.toHaveBeenCalled();
    expect(env.RELAY_NODE_TOKEN).toBe('preexisting');
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing RELAY_BASE_URL when applying enrollment creds', async () => {
    const resolveEnrollment = vi.fn(
      () => enrollmentRecord
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({
      env: { RELAY_BASE_URL: 'https://existing.example' },
      resolveEnrollment,
    });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(env.RELAY_NODE_TOKEN).toBe('nt_secret');
    expect(env.RELAY_BASE_URL).toBe('https://existing.example');
  });

  it('proceeds without enrollment when the store has no match', async () => {
    const resolveEnrollment = vi.fn(
      () => undefined
    ) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, env } = createNodeHarness({ env: {}, resolveEnrollment });

    await program.parseAsync(['node', 'up'], { from: 'user' });

    expect(env.RELAY_NODE_TOKEN).toBeUndefined();
    expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
  });

  it('surfaces an ambiguous enrollment as a clear error and exits 1', async () => {
    const resolveEnrollment = vi.fn(() => {
      throw new Error('Multiple fleet node enrollments match; pass baseUrl and workspaceId to disambiguate.');
    }) as unknown as NodeCommandDependencies['resolveEnrollment'];
    const { program, error } = createNodeHarness({ env: {}, resolveEnrollment });

    await expect(program.parseAsync(['node', 'up'], { from: 'user' })).rejects.toMatchObject({ code: 1 });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Multiple fleet node enrollments match'));
    expect(brokerMocks.runUpCommand).not.toHaveBeenCalled();
  });

  it('forwards --config through to runUpCommand', async () => {
    const { program } = createNodeHarness({ env: { RELAY_NODE_TOKEN: 'x' } });

    await program.parseAsync(['node', 'up', '--config', 'agent-relay.ts'], { from: 'user' });

    expect(brokerMocks.runUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ config: 'agent-relay.ts' }),
      expect.anything()
    );
  });
});
