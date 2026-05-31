import type { Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';

export type ChannelCommandDependencies = SdkCommandDeps;

export function registerChannelCommands(
  program: Command,
  overrides: Partial<ChannelCommandDependencies> = {}
): void {
  const deps = withSdkDefaults(overrides);
  const group = program.command('channel').description('Manage channels (requires agent token)');

  const opts = (o: Record<string, unknown>) => sdkOptionsFromOpts(o);

  addSdkOptions(
    group
      .command('create')
      .description('Create a channel')
      .argument('<name>', 'Channel name')
      .option('--topic <topic>', 'Channel topic')
  ).action(async (name: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createAgentRelay(opts(o));
      printJson(deps, await relay.channels.create({ name, topic: o.topic as string | undefined }));
    });
  });

  addSdkOptions(
    group.command('list').description('List channels').option('--archived', 'Include archived')
  ).action(async (o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createAgentRelay(opts(o));
      printJson(deps, await relay.channels.list({ includeArchived: Boolean(o.archived) }));
    });
  });

  addSdkOptions(
    group.command('join').description('Join a channel').argument('<name>', 'Channel name')
  ).action(async (name: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await deps.createAgentRelay(opts(o)).channels.join(name);
      deps.log(`Joined ${name}.`);
    });
  });

  addSdkOptions(
    group.command('leave').description('Leave a channel').argument('<name>', 'Channel name')
  ).action(async (name: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await deps.createAgentRelay(opts(o)).channels.leave(name);
      deps.log(`Left ${name}.`);
    });
  });

  addSdkOptions(
    group
      .command('invite')
      .description('Invite an agent to a channel')
      .argument('<channel>', 'Channel name')
      .argument('<agent>', 'Agent name')
  ).action(async (channel: string, agent: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await deps.createAgentRelay(opts(o)).channels.invite(channel, agent);
      deps.log(`Invited ${agent} to ${channel}.`);
    });
  });

  addSdkOptions(
    group
      .command('set_topic')
      .description('Set a channel topic')
      .argument('<name>', 'Channel name')
      .argument('<topic>', 'New topic')
  ).action(async (name: string, topic: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).channels.update(name, { topic }));
    });
  });

  addSdkOptions(
    group.command('archive').description('Archive a channel').argument('<name>', 'Channel name')
  ).action(async (name: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await deps.createAgentRelay(opts(o)).channels.archive(name);
      deps.log(`Archived ${name}.`);
    });
  });
}
