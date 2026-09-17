import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  deprecateCommand,
  formatDeprecationWarning,
  hiddenCommandNames,
} from './deprecate-command.js';

const NOTICE = { replacement: 'agent-relay flows run', since: '12.3.0' };

function programWithCloud(): { program: Command; cloud: Command; ran: string[] } {
  const ran: string[] = [];
  const program = new Command('agent-relay');
  program.exitOverride();
  const cloud = program.command('cloud').description('Cloud commands');
  cloud
    .command('run')
    .description('Submit a workflow run')
    .argument('<workflow>')
    .action((workflow: string) => {
      ran.push(`run:${workflow}`);
    });
  cloud
    .command('schedule')
    .description('Schedule a repeatable workflow run')
    .action(() => {
      ran.push('schedule');
    });
  cloud
    .command('login')
    .description('Authenticate with Agent Relay Cloud')
    .action(() => {
      ran.push('login');
    });
  return { program, cloud, ran };
}

describe('formatDeprecationWarning', () => {
  it('names the invocation, the version, and the replacement', () => {
    const warning = formatDeprecationWarning('agent-relay cloud run', NOTICE);
    expect(warning).toContain('`agent-relay cloud run` is deprecated since 12.3.0');
    expect(warning).toContain('Use `agent-relay flows run` instead.');
  });

  it('appends the note when the replacement is not a drop-in', () => {
    expect(
      formatDeprecationWarning('agent-relay cloud sync', {
        ...NOTICE,
        note: 'v2 syncs on completion; no separate step is needed.',
      })
    ).toContain('v2 syncs on completion; no separate step is needed.');
  });
});

describe('formatDeprecationWarning without a replacement', () => {
  it('admits the gap instead of inventing a pointer', () => {
    // v1 `cloud schedule` has no v2 equivalent; naming a command that does not
    // exist would send people to a dead end.
    const warning = formatDeprecationWarning('agent-relay cloud schedule', { since: '12.3.0' });
    expect(warning).toContain('No replacement is available yet');
    expect(warning).toContain('remains supported until one ships');
    expect(warning).not.toContain('undefined');
  });

  it('prefers a specific note over the generic no-replacement line', () => {
    // Printing both says the same thing twice.
    const warning = formatDeprecationWarning('agent-relay cloud schedule', {
      since: '12.3.0',
      note: 'Relayflows v2 has no hosted scheduling yet.',
    });
    expect(warning).toContain('Relayflows v2 has no hosted scheduling yet.');
    expect(warning).not.toContain('No replacement is available yet');
  });
});

describe('deprecateCommand', () => {
  it('keeps a replacement-less command visible in help', () => {
    // Hiding the only way to do a job strands the people relying on it.
    const { cloud } = programWithCloud();
    deprecateCommand(
      cloud.commands.find((c) => c.name() === 'schedule')!,
      { since: '12.3.0', keepVisible: true },
      { warn: () => {} }
    );

    expect(cloud.helpInformation()).toMatch(/^\s+schedule\b/m);
  });

  it('marks a replacement-less command without naming one', () => {
    const { cloud } = programWithCloud();
    const schedule = cloud.commands.find((c) => c.name() === 'schedule')!;
    deprecateCommand(schedule, { since: '12.3.0', keepVisible: true }, { warn: () => {} });

    expect(schedule.description()).toBe('Schedule a repeatable workflow run (deprecated)');
    expect(schedule.description()).not.toContain('undefined');
  });

  it('still runs the original action', async () => {
    const { program, cloud, ran } = programWithCloud();
    deprecateCommand(cloud.commands.find((c) => c.name() === 'run')!, NOTICE, { warn: () => {} });

    await program.parseAsync(['cloud', 'run', 'flow.yaml'], { from: 'user' });

    expect(ran).toEqual(['run:flow.yaml']);
  });

  it('warns once, with the full invocation path', async () => {
    const { program, cloud } = programWithCloud();
    const warn = vi.fn();
    deprecateCommand(cloud.commands.find((c) => c.name() === 'run')!, NOTICE, { warn });

    await program.parseAsync(['cloud', 'run', 'flow.yaml'], { from: 'user' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('`agent-relay cloud run` is deprecated');
  });

  it('hides the command from the parent help but leaves its siblings', () => {
    const { cloud } = programWithCloud();
    deprecateCommand(cloud.commands.find((c) => c.name() === 'run')!, NOTICE, { warn: () => {} });

    const help = cloud.helpInformation();
    expect(help).not.toMatch(/^\s+run\b/m);
    expect(help).toMatch(/^\s+login\b/m);
  });

  it('hides several deprecated siblings, not just the last one', () => {
    // The help override is installed once per parent; a naive implementation
    // would let the second call replace the first and un-hide `run`.
    const { cloud } = programWithCloud();
    const warn = () => {};
    deprecateCommand(cloud.commands.find((c) => c.name() === 'run')!, NOTICE, { warn });
    deprecateCommand(cloud.commands.find((c) => c.name() === 'schedule')!, NOTICE, { warn });

    const help = cloud.helpInformation();
    expect(help).not.toMatch(/^\s+run\b/m);
    expect(help).not.toMatch(/^\s+schedule\b/m);
    expect(help).toMatch(/^\s+login\b/m);
    expect(hiddenCommandNames(cloud).sort()).toEqual(['run', 'schedule']);
  });

  it('marks the description so the command says so when asked directly', () => {
    const { cloud } = programWithCloud();
    const run = cloud.commands.find((c) => c.name() === 'run')!;
    deprecateCommand(run, NOTICE, { warn: () => {} });

    expect(run.description()).toBe(
      'Submit a workflow run (deprecated — use `agent-relay flows run`)'
    );
  });

  it('does not warn when a non-deprecated sibling runs', async () => {
    const { program, cloud } = programWithCloud();
    const warn = vi.fn();
    deprecateCommand(cloud.commands.find((c) => c.name() === 'run')!, NOTICE, { warn });

    await program.parseAsync(['cloud', 'login'], { from: 'user' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses to deprecate a detached command', () => {
    expect(() => deprecateCommand(new Command('orphan'), NOTICE)).toThrow(
      /not attached to a parent command/
    );
  });
});
