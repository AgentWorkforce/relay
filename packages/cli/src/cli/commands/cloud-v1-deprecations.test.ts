import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  V1_DEPRECATED_COMMAND_NAMES,
  applyV1FlowsDeprecations,
} from './cloud-v1-deprecations.js';

/** A stand-in for the real `cloud` group with the commands this module targets. */
function cloudGroup(names: readonly string[] = [
  'run',
  'schedule',
  'schedules',
  'status',
  'logs',
  'sync',
  'cancel',
]): { program: Command; cloud: Command } {
  const program = new Command('agent-relay');
  program.exitOverride();
  const cloud = program.command('cloud').description('Cloud commands');
  for (const name of names) {
    const command = cloud.command(name).description(`${name} description`);
    if (name === 'run') {
      command
        .argument('[workflow]')
        .option('--relayflow-version <version>', 'Relayflow engine generation')
        .action(() => {});
    } else {
      command.action(() => {});
    }
  }
  return { program, cloud };
}

describe('V1_DEPRECATED_COMMAND_NAMES', () => {
  it('covers only the commands that cannot serve a v2 run', () => {
    // `status`, `logs`, `sync`, and `cancel` take a run id and query the Cloud
    // API for whichever engine produced it. Deprecating them would tell v2
    // users their run-management commands are going away, which is false.
    expect([...V1_DEPRECATED_COMMAND_NAMES].sort()).toEqual(['schedule', 'schedules']);
  });
});

describe('applyV1FlowsDeprecations', () => {
  it('warns when a v1-only command runs', async () => {
    const { program, cloud } = cloudGroup();
    const warn = vi.fn();
    applyV1FlowsDeprecations(cloud, { warn });

    await program.parseAsync(['cloud', 'schedules'], { from: 'user' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('`agent-relay cloud schedules` is deprecated');
    expect(warn.mock.calls[0]![0]).toContain('no hosted scheduling yet');
  });

  it('keeps the v1-only commands visible in help', async () => {
    // v2 has no scheduling, so these are still the only way to do the job.
    const { cloud } = cloudGroup();
    applyV1FlowsDeprecations(cloud, { warn: () => {} });

    const help = cloud.helpInformation();
    expect(help).toMatch(/^\s+schedule\b/m);
    expect(help).toMatch(/^\s+schedules\b/m);
  });

  it.each(['status', 'logs', 'sync', 'cancel'])(
    'leaves the engine-agnostic command `%s` undeprecated',
    async (name) => {
      const { program, cloud } = cloudGroup();
      const warn = vi.fn();
      applyV1FlowsDeprecations(cloud, { warn });

      await program.parseAsync(['cloud', name], { from: 'user' });

      expect(warn).not.toHaveBeenCalled();
      expect(cloud.commands.find((c) => c.name() === name)!.description()).not.toContain(
        'deprecated'
      );
    }
  );

  it('warns on an explicit v1 engine selector', async () => {
    const { program, cloud } = cloudGroup();
    const warn = vi.fn();
    applyV1FlowsDeprecations(cloud, { warn });

    await program.parseAsync(['cloud', 'run', 'flow.yaml', '--relayflow-version', 'v1'], {
      from: 'user',
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('`--relayflow-version v1` is deprecated');
    expect(warn.mock.calls[0]![0]).toContain('agent-relay flows run --cloud');
  });

  it('stays silent for v2 and for an omitted selector', async () => {
    // An omitted flag leaves the engine choice to Cloud and says nothing about
    // the caller's intent, so there is nothing to warn about.
    const { program, cloud } = cloudGroup();
    const warn = vi.fn();
    applyV1FlowsDeprecations(cloud, { warn });

    await program.parseAsync(['cloud', 'run', 'flow.yaml', '--relayflow-version', 'v2'], {
      from: 'user',
    });
    await program.parseAsync(['cloud', 'run', 'flow.yaml'], { from: 'user' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not deprecate `run` itself, which still serves both engines', () => {
    const { cloud } = cloudGroup();
    applyV1FlowsDeprecations(cloud, { warn: () => {} });

    expect(cloud.commands.find((c) => c.name() === 'run')!.description()).not.toContain(
      'deprecated'
    );
    expect(cloud.helpInformation()).toMatch(/^\s+run\b/m);
  });

  it('fails loudly if a targeted command was renamed away', () => {
    // Otherwise a rename would silently drop the deprecation notice and we
    // would ship a v1 command with no warning at all.
    const { cloud } = cloudGroup(['run', 'status']);

    expect(() => applyV1FlowsDeprecations(cloud, { warn: () => {} })).toThrow(
      /cannot deprecate `agent-relay cloud schedule`/
    );
  });

  it('fails loudly if `run` was renamed away', () => {
    const { cloud } = cloudGroup(['schedule', 'schedules']);

    expect(() => applyV1FlowsDeprecations(cloud, { warn: () => {} })).toThrow(
      /cannot deprecate the v1 selector/
    );
  });
});
