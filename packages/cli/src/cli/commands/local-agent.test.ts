import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

const harnessConnectMock = vi.hoisted(() => vi.fn());

vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: {
    connect: harnessConnectMock,
  },
}));

import {
  formatPrettyAgentList,
  registerLocalAgentCommands,
  type LocalAgentDependencies,
} from './local-agent.js';

function harness(overrides: Partial<LocalAgentDependencies> = {}) {
  const client = {
    listAgents: vi.fn(async () => [{ name: 'lead' }]),
    spawnPty: vi.fn(async () => undefined),
    spawnHeadless: vi.fn(async () => undefined),
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

  it('forwards native harness output flags to the attach runner', async () => {
    const { program, attach } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--json', '--reasoning', '--diagnostics'], {
      from: 'user',
    });
    expect(attach).toHaveBeenCalledWith(
      'lead',
      'view',
      expect.objectContaining({ json: true, reasoning: true, diagnostics: true })
    );
  });

  it('attach rejects an unknown mode', async () => {
    const { program, attach, error, exit } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--mode', 'bogus'], { from: 'user' });
    expect(attach).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown attach mode'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('list queries the broker and keeps JSON as the default output', async () => {
    const { program, client, log } = harness();
    await program.parseAsync(['local', 'agent', 'list'], { from: 'user' });
    expect(client.listAgents).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[\n  {\n    "name": "lead"\n  }\n]');
  });

  it('list --pretty shows the compact human-readable view', async () => {
    const { program, log } = harness({
      connect: vi.fn(
        async () =>
          ({
            listAgents: vi.fn(async () => [
              {
                name: 'Lead',
                runtime: 'pty' as const,
                cli: 'codex',
                model: 'gpt-5.4',
                channels: [],
                current_state: 'working' as const,
                pending_messages: 3,
                last_activity_at: '2026-07-22T16:59:57.000Z',
              },
            ]),
          }) as never
      ),
      now: () => new Date('2026-07-22T17:00:00.000Z'),
    });

    await program.parseAsync(['local', 'agent', 'list', '--pretty'], { from: 'user' });

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Lead  codex / gpt-5.4  ● working  3        now')
    );
  });

  it('formats agent state and activity time for the pretty list', () => {
    expect(
      formatPrettyAgentList(
        [
          {
            name: 'Review',
            runtime: 'pty',
            cli: 'claude',
            channels: [],
            current_state: 'blocked_on_send',
            pending_messages: 2,
            last_activity_at: '2026-07-22T16:58:00.000Z',
          },
          { name: 'Worker', runtime: 'headless', channels: [], current_state: 'idle' },
        ],
        new Date('2026-07-22T17:00:00.000Z')
      )
    ).toMatch(/Review\s+claude\s+◐ waiting\s+2\s+2 minutes ago/);
    expect(formatPrettyAgentList([], new Date())).toBe('No agents running.');
  });

  it('shows the pending queue depth, and "-" when the broker omits it', () => {
    const [header, , withCount, withoutCount] = formatPrettyAgentList(
      [
        {
          name: 'Review',
          runtime: 'pty',
          channels: [],
          current_state: 'blocked_on_send',
          pending_messages: 4,
        },
        { name: 'Worker', runtime: 'headless', channels: [], current_state: 'idle' },
      ],
      new Date('2026-07-22T17:00:00.000Z')
    ).split('\n');

    expect(header).toMatch(/STATE\s+PENDING\s+LAST ACTIVE/);
    expect(withCount).toMatch(/◐ waiting\s+4\s+unknown/);
    expect(withoutCount).toMatch(/○ idle\s+-\s+unknown/);
  });

  it('removes terminal control sequences from broker-provided cells', () => {
    const [, , row] = formatPrettyAgentList(
      [
        {
          name: 'Lead\x1b[2J\nAgent',
          runtime: 'pty',
          cli: 'codex\nunsafe',
          model: 'gpt-5\x1b[0m',
          channels: [],
          current_state: 'working',
          last_activity_at: '2026-07-22T17:00:00.000Z',
        },
      ],
      new Date('2026-07-22T17:00:00.000Z')
    ).split('\n');

    expect(row).toContain('Lead�Agent');
    expect(row).toContain('codex�unsafe / gpt-5');
    expect(row).not.toContain('\x1b');
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

  it('spawn --runtime native launches a native harness sidecar', async () => {
    const { program, client, log } = harness();
    await program.parseAsync(
      [
        'local',
        'agent',
        'spawn',
        'codex',
        '--runtime',
        'native',
        '--name',
        'NativeWorker',
        '--task',
        'Inspect the repository',
      ],
      { from: 'user' }
    );

    expect(client.spawnPty).not.toHaveBeenCalled();
    expect(client.spawnHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'NativeWorker',
        cli: 'codex',
        task: 'Inspect the repository',
        harnessConfig: expect.objectContaining({
          runtime: 'native',
          metadata: expect.objectContaining({ runtimeKind: 'native' }),
        }),
      })
    );
    expect(log).toHaveBeenCalledWith('Spawned NativeWorker (codex, native).');
  });

  it('spawn validates runtime names and native adapter support', async () => {
    const invalid = harness();
    await invalid.program.parseAsync(['local', 'agent', 'spawn', 'codex', '--runtime', 'ai-sdk'], {
      from: 'user',
    });
    expect(invalid.client.spawnPty).not.toHaveBeenCalled();
    expect(invalid.client.spawnHeadless).not.toHaveBeenCalled();
    expect(invalid.error).toHaveBeenCalledWith(expect.stringContaining('Unknown runtime'));

    const unsupported = harness();
    await unsupported.program.parseAsync(['local', 'agent', 'spawn', 'gemini', '--runtime', 'native'], {
      from: 'user',
    });
    expect(unsupported.client.spawnPty).not.toHaveBeenCalled();
    expect(unsupported.client.spawnHeadless).not.toHaveBeenCalled();
    expect(unsupported.error).toHaveBeenCalledWith(
      expect.stringContaining('No native harness adapter is registered for gemini')
    );
  });

  it('does not accept the removed --backend option', async () => {
    const { program, client } = harness();
    await expect(
      program.parseAsync(['local', 'agent', 'spawn', 'codex', '--backend', 'ai-sdk'], {
        from: 'user',
      })
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
    expect(client.spawnPty).not.toHaveBeenCalled();
    expect(client.spawnHeadless).not.toHaveBeenCalled();
  });

  it('new --runtime native spawns native then uses structured drive attach', async () => {
    const { program, client, attach } = harness();
    await program.parseAsync(
      ['local', 'agent', 'new', 'claude', '--runtime', 'native', '--name', 'NativeClaude'],
      { from: 'user' }
    );

    expect(client.spawnHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'NativeClaude',
        harnessConfig: expect.objectContaining({ runtime: 'native' }),
      })
    );
    expect(attach).toHaveBeenCalledWith('NativeClaude', 'drive', {});
  });

  it('new rejects passthrough before spawning a native harness', async () => {
    const { program, client, attach, error } = harness();
    await program.parseAsync(
      ['local', 'agent', 'new', 'codex', '--runtime', 'native', '--mode', 'passthrough'],
      { from: 'user' }
    );

    expect(client.spawnHeadless).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('do not support passthrough'));
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

  it('spawn forwards --cwd to spawnPty', async () => {
    const { program, client } = harness();
    await program.parseAsync(
      ['local', 'agent', 'spawn', 'claude', '--name', 'Worker', '--cwd', '/home/user/my-project'],
      { from: 'user' }
    );
    expect(client.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Worker', cli: 'claude', cwd: '/home/user/my-project' })
    );
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
