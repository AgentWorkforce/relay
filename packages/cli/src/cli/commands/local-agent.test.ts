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
  formatPrettyAgentStatusList,
  registerLocalAgentCommands,
  withDeliveryStatus,
  type LocalAgentDependencies,
} from './local-agent.js';

function harness(overrides: Partial<LocalAgentDependencies> = {}) {
  const client = {
    listAgents: vi.fn(async () => [{ name: 'lead' }]),
    spawnPty: vi.fn(async () => undefined),
    spawnHeadless: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    setModel: vi.fn(async () => ({
      name: 'lead',
      model: 'opus',
      requested_model: 'opus',
      effective_model: null,
      applied: false,
      status: 'accepted_pending',
      request_id: 'model_1',
      generation: 'generation-1',
      revision: 1,
      success: false,
      accepted: true,
      pending: true,
    })),
    getModel: vi.fn(async () => ({
      name: 'lead',
      model: 'opus',
      requested_model: 'opus',
      effective_model: 'opus',
      applied: true,
      status: 'applied',
      request_id: 'model_1',
      receipt_id: 'model_1',
      generation: 'generation-1',
      revision: 1,
      success: true,
      accepted: true,
      pending: false,
    })),
    flushPending: vi.fn(async () => ({ flushed: 2 })),
    setInboundDeliveryMode: vi.fn(async (_name: string, mode: string) => ({ mode, flushed: 0 })),
  };
  const attach = vi.fn(async () => 0);
  const attachRemote = vi.fn(async () => 0);
  const attachNode = vi.fn(async () => 0);
  const redeemJoinTicket = vi.fn(async () => ({
    workspaceKey: 'rk_live_redeemed',
    workspaceId: 'rw_redeemed',
  }));
  const persistWorkspaceSession = vi.fn(() => ({}));
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  const deps: Partial<LocalAgentDependencies> = {
    connect: vi.fn(async () => client as never),
    attach,
    attachRemote,
    attachNode,
    redeemJoinTicket,
    persistWorkspaceSession,
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
  return {
    program,
    client,
    attach,
    attachRemote,
    attachNode,
    redeemJoinTicket,
    persistWorkspaceSession,
    log,
    error,
    exit,
  };
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

  it('attach --ssh-host runs the existing attach command on an SSH-reachable physical node', async () => {
    const { program, attach, attachRemote } = harness();
    await program.parseAsync(
      ['local', 'agent', 'attach', 'lead', '--ssh-host', 'barry', '--mode', 'drive', '--reasoning'],
      { from: 'user' }
    );
    expect(attach).not.toHaveBeenCalled();
    expect(attachRemote).toHaveBeenCalledWith(
      'lead',
      'drive',
      'barry',
      expect.objectContaining({ reasoning: true })
    );
  });

  it('attach --ssh-host delegates an empty value to remote host validation', async () => {
    const { program, attach, attachRemote } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--ssh-host', ''], { from: 'user' });
    expect(attach).not.toHaveBeenCalled();
    expect(attachRemote).toHaveBeenCalledWith('lead', 'view', '', expect.objectContaining({}));
  });

  it('attach --node opens the canonical authenticated terminal path without invoking SSH', async () => {
    const { program, attach, attachRemote, attachNode } = harness();
    await program.parseAsync(
      ['local', 'agent', 'attach', 'lead', '--node', 'daytona-live', '--mode', 'passthrough', '--json'],
      { from: 'user' }
    );
    expect(attach).not.toHaveBeenCalled();
    expect(attachRemote).not.toHaveBeenCalled();
    expect(attachNode).toHaveBeenCalledWith(
      'lead',
      'passthrough',
      'daytona-live',
      expect.objectContaining({ json: true })
    );
  });

  it('attach --node rejects the SSH fallback conflict', async () => {
    const { program, attachNode, attachRemote, error, exit } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--node', 'finn', '--ssh-host', 'finn'], {
      from: 'user',
    });
    expect(attachNode).not.toHaveBeenCalled();
    expect(attachRemote).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--node cannot be combined with --ssh-host'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ['--broker-url', 'http://127.0.0.1:7777'],
    ['--api-key', 'do-not-forward'],
    ['--state-dir', '/tmp/relay-state'],
  ])('attach --node rejects local broker option %s', async (flag, value) => {
    const { program, attachNode, error, exit } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--node', 'finn', flag, value], {
      from: 'user',
    });
    expect(attachNode).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--node cannot be combined'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('attach --node forwards --workspace-key so a copy-pasted command is cwd-independent', async () => {
    const { program, attachNode } = harness();
    await program.parseAsync(
      ['local', 'agent', 'attach', 'lead', '--node', 'sf-mini', '--workspace-key', 'rk_live_explicit'],
      { from: 'user' }
    );
    expect(attachNode).toHaveBeenCalledWith(
      'lead',
      'view',
      'sf-mini',
      expect.objectContaining({ workspaceKey: 'rk_live_explicit' })
    );
  });

  it('attach --node without --workspace-key leaves the precedence ladder to resolve it', async () => {
    const { program, attachNode } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--node', 'sf-mini'], { from: 'user' });
    expect(attachNode).toHaveBeenCalledWith(
      'lead',
      'view',
      'sf-mini',
      expect.objectContaining({ workspaceKey: undefined })
    );
  });

  it('attach --node treats a blank --workspace-key as unset rather than a literal credential', async () => {
    const { program, attachNode } = harness();
    await program.parseAsync(
      ['local', 'agent', 'attach', 'lead', '--node', 'sf-mini', '--workspace-key', '   '],
      { from: 'user' }
    );
    expect(attachNode).toHaveBeenCalledWith(
      'lead',
      'view',
      'sf-mini',
      expect.objectContaining({ workspaceKey: undefined })
    );
  });

  it('attach --node redeems and persists a join ticket, then attaches with the redeemed credential', async () => {
    const env = { RELAY_WORKSPACE_KEY: 'rk_live_wrong_ambient' };
    const { program, attachNode, redeemJoinTicket, persistWorkspaceSession, log, error } = harness({ env });
    await program.parseAsync(
      ['local', 'agent', 'attach', 'lead', '--node', 'sf-mini', '--join-ticket', 'rjt_live_one_time'],
      { from: 'user' }
    );

    expect(redeemJoinTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: 'rjt_live_one_time',
        node: 'sf-mini',
        agent: 'lead',
        mode: 'view',
        env,
      })
    );
    expect(persistWorkspaceSession).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_redeemed',
      workspaceId: 'rw_redeemed',
      projectRoot: '/tmp/project',
    });
    expect(attachNode).toHaveBeenCalledWith(
      'lead',
      'view',
      'sf-mini',
      expect.objectContaining({ workspaceKey: 'rk_live_redeemed' })
    );
    expect(JSON.stringify(persistWorkspaceSession.mock.calls)).not.toContain('rjt_live_one_time');
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain('rjt_live_one_time');
  });

  it.each(['expired', 'invalid'])(
    'attach --node reports a clear %s join-ticket error instead of falling through to workspace resolution',
    async (reason) => {
      const redeemJoinTicket = vi.fn(async () => {
        throw new Error(`Error: Join ticket is ${reason}. Request a new attach command.`);
      });
      const { program, attachNode, persistWorkspaceSession, error, exit } = harness({
        redeemJoinTicket,
      });
      await program.parseAsync(
        ['local', 'agent', 'attach', 'lead', '--node', 'sf-mini', '--join-ticket', 'rjt_live_dead'],
        { from: 'user' }
      );

      expect(attachNode).not.toHaveBeenCalled();
      expect(persistWorkspaceSession).not.toHaveBeenCalled();
      const message = String(error.mock.calls.at(0)?.[0]);
      expect(message).toContain(`Join ticket is ${reason}`);
      expect(message).not.toContain('No workspace key found');
      expect(message).not.toContain('rjt_live_dead');
      expect(exit).toHaveBeenCalledWith(1);
    }
  );

  it('attach --node rejects an empty join ticket instead of using the existing credential ladder', async () => {
    const { program, attachNode, redeemJoinTicket, error, exit } = harness();
    await program.parseAsync(
      ['local', 'agent', 'attach', 'lead', '--node', 'sf-mini', '--join-ticket', '   '],
      { from: 'user' }
    );

    expect(redeemJoinTicket).not.toHaveBeenCalled();
    expect(attachNode).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Error: --join-ticket requires a non-empty ticket.');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('attach --node rejects conflicting join-ticket and workspace-key credentials', async () => {
    const { program, attachNode, redeemJoinTicket, error, exit } = harness();
    await program.parseAsync(
      [
        'local',
        'agent',
        'attach',
        'lead',
        '--node',
        'sf-mini',
        '--join-ticket',
        'rjt_live_one_time',
        '--workspace-key',
        'rk_live_explicit',
      ],
      { from: 'user' }
    );

    expect(redeemJoinTicket).not.toHaveBeenCalled();
    expect(attachNode).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Error: --join-ticket cannot be combined with --workspace-key.');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('attach rejects --join-ticket without --node instead of silently using a local broker', async () => {
    const { program, attach, attachNode, redeemJoinTicket, error, exit } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--join-ticket', 'rjt_live_one_time'], {
      from: 'user',
    });

    expect(attach).not.toHaveBeenCalled();
    expect(attachNode).not.toHaveBeenCalled();
    expect(redeemJoinTicket).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--join-ticket requires --node'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('attach rejects --workspace-key without --node instead of silently ignoring it', async () => {
    const { program, attach, attachNode, error, exit } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--workspace-key', 'rk_live_explicit'], {
      from: 'user',
    });
    expect(attach).not.toHaveBeenCalled();
    expect(attachNode).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--workspace-key requires --node'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  // `--workspace-key "$KEY"` with an unset variable reaches the parser as a
  // blank string. Normalizing it away before the path check would hand the
  // caller a silent local attach against whatever broker happened to be there.
  it('attach rejects a blank --workspace-key without --node rather than falling through to the local broker', async () => {
    const { program, attach, attachNode, error, exit } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--workspace-key', '   '], {
      from: 'user',
    });
    expect(attach).not.toHaveBeenCalled();
    expect(attachNode).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--workspace-key requires --node'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('attach rejects a blank --workspace-key on the --ssh-host path rather than silently attaching', async () => {
    const { program, attachRemote, attachNode, error, exit } = harness();
    await program.parseAsync(
      ['local', 'agent', 'attach', 'lead', '--ssh-host', 'barry', '--workspace-key', ''],
      { from: 'user' }
    );
    expect(attachRemote).not.toHaveBeenCalled();
    expect(attachNode).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--workspace-key requires --node'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  // The two rejected paths do not take the same credentials: --ssh-host itself
  // rejects --broker-url / --api-key, so naming them there sends the caller
  // into a second, contradictory error.
  it('attach points a rejected local-broker caller at its supported connection options', async () => {
    const { program, error } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--workspace-key', 'rk_live_explicit'], {
      from: 'user',
    });
    const message = error.mock.calls.at(0)?.[0] as string;
    expect(message).toContain('--broker-url');
    expect(message).toContain('--api-key');
    expect(message).toContain('--state-dir');
    // Guidance for a path the caller is not on is guidance they cannot follow.
    expect(message).not.toContain('--ssh-host');
  });

  it('attach points a rejected --ssh-host caller at --state-dir, not the flags that path forbids', async () => {
    const { program, error } = harness();
    await program.parseAsync(
      ['local', 'agent', 'attach', 'lead', '--ssh-host', 'barry', '--workspace-key', 'rk_live_explicit'],
      { from: 'user' }
    );
    const message = error.mock.calls.at(0)?.[0] as string;
    expect(message).toContain('--state-dir');
    expect(message).not.toContain('--broker-url');
    expect(message).not.toContain('--api-key');
  });

  it('attach --node prefixes a terminal setup error once', async () => {
    const attachNode = vi.fn(async () => {
      throw new Error('terminal unavailable');
    });
    const { program, error, exit } = harness({ attachNode });
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--node', 'finn'], { from: 'user' });
    expect(error).toHaveBeenCalledWith('Error: terminal unavailable');
    expect(error).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ['--api-key', 'do-not-forward'],
    ['--api-key', ''],
    ['--broker-url', ''],
  ])('attach --ssh-host rejects conflicting %s values even when empty', async (flag, value) => {
    const { program, attach, attachRemote, error, exit } = harness();
    await program.parseAsync(['local', 'agent', 'attach', 'lead', '--ssh-host', 'barry', flag, value], {
      from: 'user',
    });
    expect(attach).not.toHaveBeenCalled();
    expect(attachRemote).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--ssh-host cannot be combined'));
    expect(exit).toHaveBeenCalledWith(1);
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

  it('list --status enriches each agent with delivery mode and pending contents (relay#1387)', async () => {
    const getInboundDeliveryMode = vi.fn(async () => 'manual_flush');
    const getPending = vi.fn(async () => [
      { from: 'a', body: 'hi', target: 'b', priority: 0, mode: 'wait', queued_at_ms: 1 },
    ]);
    const { program, log } = harness({
      connect: vi.fn(
        async () =>
          ({
            listAgents: vi.fn(async () => [{ name: 'lead' }]),
            getInboundDeliveryMode,
            getPending,
          }) as never
      ),
    });

    await program.parseAsync(['local', 'agent', 'list', '--status'], { from: 'user' });

    expect(getInboundDeliveryMode).toHaveBeenCalledWith('lead');
    expect(getPending).toHaveBeenCalledWith('lead');
    const parsed = JSON.parse(log.mock.calls[0]![0] as string);
    expect(parsed).toEqual([
      {
        name: 'lead',
        delivery_mode: 'manual_flush',
        pending: [{ from: 'a', body: 'hi', target: 'b', priority: 0, mode: 'wait', queued_at_ms: 1 }],
      },
    ]);
  });

  it('list --status --pretty marks manual_flush + non-empty queue as stuck, and auto_inject + empty queue as not stuck', () => {
    const now = new Date('2026-08-16T18:00:00.000Z');
    const stuckAgent = {
      name: 'stuck-agent',
      runtime: 'pty' as const,
      channels: [],
      last_activity_at: '2026-08-16T17:00:00.000Z',
      delivery_mode: 'manual_flush' as const,
      pending: [
        { from: 'a', body: 'hi', target: 'stuck-agent', priority: 0, mode: 'wait' as const, queued_at_ms: 1 },
      ],
    };
    const healthyAgent = {
      name: 'healthy-agent',
      runtime: 'pty' as const,
      channels: [],
      last_activity_at: '2026-08-16T17:59:00.000Z',
      delivery_mode: 'auto_inject' as const,
      pending: [],
    };

    const [, , stuckRow, healthyRow] = formatPrettyAgentStatusList([stuckAgent, healthyAgent], now).split(
      '\n'
    );

    expect(stuckRow).toMatch(/stuck-agent\s+manual_flush\s+1\s+yes/);
    expect(healthyRow).toMatch(/healthy-agent\s+auto_inject\s+0\s+no/);
  });

  it('list --status --pretty renders a failed pending lookup as unknown, distinct from empty and stuck', async () => {
    const now = new Date('2026-08-16T18:00:00.000Z');
    const client = {
      getInboundDeliveryMode: vi.fn(async () => 'manual_flush'),
      getPending: vi.fn(async (name: string) => {
        if (name === 'unknown-agent') throw new Error('broker unavailable');
        return name === 'stuck-agent'
          ? [{ from: 'a', body: 'hi', target: name, priority: 0, mode: 'wait' as const, queued_at_ms: 1 }]
          : [];
      }),
    };

    const result = await withDeliveryStatus(client as never, [
      {
        name: 'stuck-agent',
        runtime: 'pty',
        channels: [],
        last_activity_at: '2026-08-16T17:00:00.000Z',
      } as never,
      {
        name: 'empty-agent',
        runtime: 'pty',
        channels: [],
        last_activity_at: '2026-08-16T17:00:00.000Z',
      } as never,
      {
        name: 'unknown-agent',
        runtime: 'pty',
        channels: [],
        last_activity_at: '2026-08-16T17:00:00.000Z',
      } as never,
    ]);
    const [, , stuckRow, emptyRow, unknownRow] = formatPrettyAgentStatusList(result, now).split('\n');

    expect(stuckRow).toMatch(/stuck-agent\s+manual_flush\s+1\s+yes/);
    expect(emptyRow).toMatch(/empty-agent\s+manual_flush\s+0\s+no/);
    expect(unknownRow).toMatch(/unknown-agent\s+manual_flush\s+-\s+unknown/);
  });

  it('withDeliveryStatus bounds concurrent broker reads while preserving input order', async () => {
    let activeReads = 0;
    let peakReads = 0;
    let releaseReads: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const read = <T>(value: T) =>
      vi.fn(async () => {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        try {
          await readsReleased;
          return value;
        } finally {
          activeReads -= 1;
        }
      });
    const client = {
      getInboundDeliveryMode: read('auto_inject'),
      getPending: read([]),
    };
    const agents = Array.from({ length: 5 }, (_, index) => ({ name: `agent-${index}` }) as never);

    const result = withDeliveryStatus(client as never, agents);

    expect(activeReads).toBe(8);
    releaseReads!();

    await expect(result).resolves.toMatchObject(agents);
    expect(peakReads).toBe(8);
    expect(client.getInboundDeliveryMode).toHaveBeenCalledTimes(5);
    expect(client.getPending).toHaveBeenCalledTimes(5);
  });

  it('withDeliveryStatus tolerates a per-agent delivery mode fetch failure', async () => {
    const client = {
      getInboundDeliveryMode: vi.fn(async (name: string) =>
        name === 'broken' ? Promise.reject(new Error('gone')) : 'auto_inject'
      ),
      getPending: vi.fn(async () => []),
    };

    const result = await withDeliveryStatus(client as never, [
      { name: 'ok' } as never,
      { name: 'broken' } as never,
    ]);

    expect(result[0]).toMatchObject({ name: 'ok', delivery_mode: 'auto_inject', pending: [] });
    expect(result[1]).toMatchObject({ name: 'broken', delivery_mode: undefined });
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

  it('set-model --json emits a normalized correlated receipt', async () => {
    const { program, log, client } = harness();
    vi.useFakeTimers();
    try {
      const command = program.parseAsync(['local', 'agent', 'set-model', 'lead', 'opus', '--json'], {
        from: 'user',
      });
      await vi.runAllTimersAsync();
      await command;
    } finally {
      vi.useRealTimers();
    }
    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          name: 'lead',
          requestedModel: 'opus',
          effectiveModel: 'opus',
          applied: true,
          status: 'applied',
          requestId: 'model_1',
          receiptId: 'model_1',
          generation: 'generation-1',
          revision: 1,
          success: true,
          accepted: true,
          pending: false,
        },
        null,
        2
      )
    );
    expect(client.getModel).toHaveBeenCalledWith('lead', 'model_1');
  });

  it('set-model reports unsupported without claiming application', async () => {
    const { program, client, log } = harness();
    client.setModel = vi.fn(async () => ({
      name: 'lead',
      model: 'opus',
      requested_model: 'opus',
      effective_model: null,
      applied: false,
      status: 'unsupported',
      request_id: 'model_2',
      generation: 'generation-1',
      revision: 2,
      success: false,
      accepted: false,
      pending: false,
    }));
    await program.parseAsync(['local', 'agent', 'set-model', 'lead', 'opus'], { from: 'user' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unsupported'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('applied=false'));
  });

  it('set-model polls an accepted receipt even when its request id is empty', async () => {
    const { program, client } = harness();
    client.setModel = vi.fn(async () => ({
      name: 'lead',
      model: 'opus',
      requested_model: 'opus',
      effective_model: null,
      applied: false,
      status: 'accepted_pending',
      request_id: '',
      generation: 'generation-1',
      revision: 1,
      success: false,
      accepted: true,
      pending: true,
    }));
    client.getModel = vi.fn(async () => ({
      name: 'lead',
      model: 'opus',
      requested_model: 'opus',
      effective_model: 'opus',
      applied: true,
      status: 'applied',
      request_id: '',
      receipt_id: '',
      generation: 'generation-1',
      revision: 1,
      success: true,
      accepted: true,
      pending: false,
    }));
    vi.useFakeTimers();
    try {
      const command = program.parseAsync(['local', 'agent', 'set-model', 'lead', 'opus'], {
        from: 'user',
      });
      await vi.runAllTimersAsync();
      await command;
    } finally {
      vi.useRealTimers();
    }
    expect(client.getModel).toHaveBeenCalledWith('lead', '');
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
