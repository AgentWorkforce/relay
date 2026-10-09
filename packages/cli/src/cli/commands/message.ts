import type { AgentRelayAgent, RelayFileInfo } from '@agent-relay/sdk';
import { InvalidArgumentError, type Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import {
  directMessageDeliveryFailure,
  directMessageReceipt,
  messageReadersReceipt,
  resolveExactAgentName,
} from '../lib/message-delivery-receipts.js';
import { readAttachment, saveAttachment } from '../lib/attachments.js';

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

function parseMessageMode(value: string): 'wait' | 'steer' {
  if (value === 'wait' || value === 'steer') {
    return value;
  }
  throw new InvalidArgumentError('mode must be "wait" or "steer"');
}

function collectFile(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Upload local files and return the stored files whose ids a message can attach. */
async function uploadFiles(
  relay: AgentRelayAgent,
  filePaths: string[] | undefined
): Promise<RelayFileInfo[]> {
  if (!filePaths || filePaths.length === 0) return [];
  const files = relay.files;
  if (!files) {
    throw new Error('File attachments require an agent token (--token or RELAY_AGENT_TOKEN).');
  }
  // Read every file before uploading any, so one bad path sends nothing.
  const attachments = await Promise.all(filePaths.map((filePath) => readAttachment(filePath)));
  const uploaded: RelayFileInfo[] = [];
  for (const attachment of attachments) {
    uploaded.push(await files.upload(attachment));
  }
  return uploaded;
}

function attachmentIds(uploaded: RelayFileInfo[]): { attachments: string[] } | Record<string, never> {
  return uploaded.length > 0 ? { attachments: uploaded.map((file) => file.id) } : {};
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
      .option('--file <path>', 'Attach a local file (repeatable)', collectFile)
  ).action(async (channel: string, text: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createAgentRelay(opts(o));
      const uploaded = await uploadFiles(relay, o.file as string[] | undefined);
      printJson(deps, await relay.messages.send({ channel, text, ...attachmentIds(uploaded) }));
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
      .option(
        '--mode <mode>',
        'wait (default): inject on idle; steer: inject immediately and may interrupt active work',
        parseMessageMode
      )
      .option('--file <path>', 'Attach a local file (repeatable)', collectFile)
  ).action(async (agent: string, text: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const mode = o.mode as 'wait' | 'steer' | undefined;
      const options = opts(o);
      const relay = deps.createAgentRelay(options);
      const uploaded = await uploadFiles(relay, o.file as string[] | undefined);
      // Sending must remain agent-scoped for attribution, while recipient
      // resolution is a workspace-wide roster read. Keep those credentials on
      // independent clients so an ambient/explicit agent token cannot shadow
      // the workspace key supplied alongside it.
      const resolvedRecipient = await Promise.resolve()
        .then(() => deps.createWorkspaceRelay(options).agents.list())
        .then((agents) => resolveExactAgentName(agents, agent))
        .catch(() => undefined);
      const receipt = directMessageReceipt(
        await relay.messages.direct({
          to: agent,
          text,
          ...(mode ? { mode } : {}),
          ...attachmentIds(uploaded),
        }),
        agent,
        mode,
        resolvedRecipient
      );
      printJson(deps, receipt);
      const failure = directMessageDeliveryFailure(receipt);
      if (failure) {
        deps.error(failure);
        deps.exit(1);
      }
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
      .option('--file <path>', 'Attach a local file (repeatable)', collectFile)
  ).action(async (text: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createAgentRelay(opts(o));
      const uploaded = await uploadFiles(relay, o.file as string[] | undefined);
      printJson(
        deps,
        await relay.messages.groupDirect({ participants: o.to as string[], text, ...attachmentIds(uploaded) })
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
      printJson(
        deps,
        messageReadersReceipt(await deps.createAgentRelay(opts(o)).messages.readers(messageId))
      );
    });
  });

  // ── file subgroup ────────────────────────────────────────────────────────
  const file = group.command('file').description('File attachments');

  addSdkOptions(
    file
      .command('upload')
      .description('Upload a file and send it to a channel or an agent')
      .argument('<path>', 'File path')
      .option('--channel <channel>', 'Post the file to this channel')
      .option('--to <agent>', 'Send the file to this agent as a direct message')
      .option('--text <text>', 'Accompanying message text (defaults to the file name)')
  ).action(async (filePath: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const channel = o.channel as string | undefined;
      const to = o.to as string | undefined;
      if (Boolean(channel) === Boolean(to)) {
        throw new Error('Pass exactly one of --channel <channel> or --to <agent>.');
      }
      const relay = deps.createAgentRelay(opts(o));
      const uploaded = await uploadFiles(relay, [filePath]);
      const text = (o.text as string | undefined)?.trim() ? (o.text as string) : uploaded[0].filename;
      const message = channel
        ? await relay.messages.send({ channel, text, ...attachmentIds(uploaded) })
        : await relay.messages.direct({ to: to as string, text, ...attachmentIds(uploaded) });
      printJson(deps, message);
    });
  });

  addSdkOptions(
    file
      .command('get')
      .description('Show a stored file, including a short-lived download URL')
      .argument('<fileId>', 'File id')
  ).action(async (fileId: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const files = deps.createAgentRelay(opts(o)).files;
      if (!files) {
        throw new Error('Reading files requires an agent token (--token or RELAY_AGENT_TOKEN).');
      }
      printJson(deps, await files.get(fileId));
    });
  });

  addSdkOptions(
    file
      .command('download')
      .description('Download a message attachment to a local file and print its path')
      .argument('<fileId>', 'File id')
      .option(
        '--out <path>',
        'Output file, or an existing directory (default: .agent-relay/attachments/<fileId>/)'
      )
  ).action(async (fileId: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const files = deps.createAgentRelay(opts(o)).files;
      if (!files) {
        throw new Error('Downloading files requires an agent token (--token or RELAY_AGENT_TOKEN).');
      }
      const { file: info, data } = await files.download(fileId);
      const target = await saveAttachment(fileId, info.filename, data, o.out as string | undefined);
      printJson(deps, {
        id: info.id,
        filename: info.filename,
        contentType: info.contentType,
        sizeBytes: data.byteLength,
        path: target,
      });
    });
  });
}
