import { InvalidArgumentError, type Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';

export type MessageCommandDependencies = SdkCommandDeps;

function parseLimit(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError('limit must be a positive integer');
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new InvalidArgumentError('limit must be a positive integer');
  }
  return parsed;
}

export function registerMessageCommands(
  program: Command,
  overrides: Partial<MessageCommandDependencies> = {}
): void {
  const deps = withSdkDefaults(overrides);
  const opts = (o: Record<string, unknown>) => sdkOptionsFromOpts(o);
  const group = program
    .command('message')
    .description('Post, read, and react to messages (requires agent token)');

  addSdkOptions(
    group
      .command('post')
      .description('Post a message to a channel')
      .argument('<channel>', 'Channel name')
      .argument('<text>', 'Message text')
  ).action(async (channel: string, text: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).messages.send({ channel, text }));
    });
  });

  addSdkOptions(
    group
      .command('list')
      .description('List messages in a channel')
      .argument('<channel>', 'Channel name')
      .option('--limit <n>', 'Max messages', parseLimit)
  ).action(async (channel: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await deps.createAgentRelay(opts(o)).messages.list(channel, { limit: o.limit as number | undefined })
      );
    });
  });

  addSdkOptions(
    group
      .command('reply')
      .description('Reply to a message (threads)')
      .argument('<messageId>', 'Parent message id')
      .argument('<text>', 'Reply text')
  ).action(async (messageId: string, text: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).messages.reply({ messageId, text }));
    });
  });

  addSdkOptions(
    group
      .command('get_thread')
      .description('Get all messages in a thread')
      .argument('<messageId>', 'Thread/parent message id')
  ).action(async (messageId: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).threads.get(messageId));
    });
  });

  addSdkOptions(
    group
      .command('search')
      .description('Search for messages')
      .argument('<query>', 'Search query')
      .option('--channel <channel>', 'Restrict to a channel')
      .option('--from <agent>', 'Restrict to a sender')
      .option('--limit <n>', 'Max results', parseLimit)
  ).action(async (query: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await deps.createAgentRelay(opts(o)).messages.search(query, {
          channel: o.channel as string | undefined,
          from: o.from as string | undefined,
          limit: o.limit as number | undefined,
        })
      );
    });
  });

  // ── dm subgroup ──────────────────────────────────────────────────────────
  const dm = group.command('dm').description('Direct messages');

  addSdkOptions(
    dm
      .command('send')
      .description('Send a direct message to an agent')
      .argument('<agent>', 'Recipient agent')
      .argument('<text>', 'Message text')
  ).action(async (agent: string, text: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).messages.direct({ to: agent, text }));
    });
  });

  addSdkOptions(
    dm
      .command('list')
      .description('List direct messages in a conversation')
      .argument('<conversationId>', 'Conversation id')
      .option('--limit <n>', 'Max messages', parseLimit)
  ).action(async (conversationId: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await deps
          .createAgentRelay(opts(o))
          .messages.listDirect({ conversationId, limit: o.limit as number | undefined })
      );
    });
  });

  addSdkOptions(
    dm
      .command('send_group')
      .description('Send a direct message to multiple agents')
      .argument('<text>', 'Message text')
      .requiredOption('--to <agents...>', 'Recipient agents')
  ).action(async (text: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await deps.createAgentRelay(opts(o)).messages.groupDirect({ participants: o.to as string[], text })
      );
    });
  });

  // ── reaction subgroup ────────────────────────────────────────────────────
  const reaction = group.command('reaction').description('Message reactions');

  addSdkOptions(
    reaction
      .command('add')
      .description('Add a reaction to a message')
      .argument('<messageId>', 'Message id')
      .argument('<emoji>', 'Emoji')
  ).action(async (messageId: string, emoji: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).messages.react(messageId, emoji));
    });
  });

  addSdkOptions(
    reaction
      .command('remove')
      .description('Remove a reaction from a message')
      .argument('<messageId>', 'Message id')
      .argument('<emoji>', 'Emoji')
  ).action(async (messageId: string, emoji: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await deps.createAgentRelay(opts(o)).messages.unreact(messageId, emoji);
      deps.log(`Removed :${emoji}: from ${messageId}.`);
    });
  });

  // ── inbox subgroup ───────────────────────────────────────────────────────
  const inbox = group.command('inbox').description('Inbox');

  addSdkOptions(
    inbox
      .command('check')
      .description('List messages directed to you')
      .option('--limit <n>', 'Max items', parseLimit)
  ).action(async (o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await deps.createAgentRelay(opts(o)).inbox.get({ limit: o.limit as number | undefined })
      );
    });
  });

  addSdkOptions(
    inbox
      .command('mark_read')
      .description('Mark a message or thread as read')
      .argument('<messageId>', 'Message id')
  ).action(async (messageId: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).messages.markRead(messageId));
    });
  });

  addSdkOptions(
    inbox
      .command('get_readers')
      .description('See who has read a message')
      .argument('<messageId>', 'Message id')
  ).action(async (messageId: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(deps, await deps.createAgentRelay(opts(o)).messages.readers(messageId));
    });
  });

  // ── file subgroup ────────────────────────────────────────────────────────
  const file = group.command('file').description('File attachments');

  addSdkOptions(
    file
      .command('upload')
      .description('Upload a file as a message attachment')
      .argument('<path>', 'File path')
      .requiredOption('--channel <channel>', 'Target channel')
      .option('--text <text>', 'Accompanying message text', '')
  ).action(async (filePath: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await deps.createAgentRelay(opts(o)).messages.send({
          channel: o.channel as string,
          text: (o.text as string) ?? '',
          attachments: [{ type: 'file', path: filePath }],
        })
      );
    });
  });
}
