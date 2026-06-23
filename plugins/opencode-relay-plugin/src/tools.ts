import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import {
  RelayCast,
  RelayError,
  type AgentClient,
  type DmMessage,
  type InboxResponse,
  type MessageWithMeta,
  type RelayCastOptions,
} from '@relaycast/sdk';

import type { RelayMessage, RelayState } from './index.js';

export interface ToolSchemaProperty {
  type: string;
  description?: string;
}

export interface ToolSchema {
  type: 'object';
  properties: Record<string, ToolSchemaProperty>;
  required?: readonly string[];
}

export interface ToolDefinition<TInput, TResult> {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: (input: TInput) => Promise<TResult>;
}

export interface ToolContext {
  tool(definition: ToolDefinition<any, any>): void;
}

export interface RelayConnectInput {
  workspace: string;
  name: string;
}

export interface RelaySendInput {
  to: string;
  text: string;
}

export interface RelayPostInput {
  channel: string;
  text: string;
}

export interface RelaySpawnInput {
  name: string;
  task: string;
  dir?: string;
  model?: string;
}

export interface RelayDismissInput {
  name: string;
}

export type EmptyInput = Record<string, never>;
export type Message = RelayMessage;
export type SpawnLike = (command: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;

/** Constructs the workspace-scoped SDK client. Overridable in tests. */
export type RelayCastFactory = (options: RelayCastOptions) => RelayCast;

export interface ToolDependencies {
  spawn?: SpawnLike;
  createRelayCast?: RelayCastFactory;
}

const defaultCreateRelayCast: RelayCastFactory = (options) => new RelayCast(options);

function isConnected(state: RelayState): state is RelayState & {
  agentName: string;
  workspace: string;
  token: string;
  connected: true;
  relay: RelayCast;
  agent: AgentClient;
} {
  return (
    state.connected &&
    state.agentName !== null &&
    state.workspace !== null &&
    state.token !== null &&
    state.relay !== null &&
    state.agent !== null
  );
}

export function assertConnected(state: RelayState): asserts state is RelayState & {
  agentName: string;
  workspace: string;
  token: string;
  connected: true;
  relay: RelayCast;
  agent: AgentClient;
} {
  if (!isConnected(state)) {
    throw new Error('Not connected to Relay. Call relay_connect first.');
  }
}

/**
 * Per-conversation/channel cap on how many unread messages we hydrate when the
 * summary reports more than one unread item. Keeps a single idle poll bounded.
 */
const MAX_UNREAD_FETCH = 50;

/**
 * Flatten an engine inbox *summary* payload into the flat message list the
 * plugin's UX is built around. `/v1/inbox` has no `messages` array; the
 * message-like items are channel `mentions` and the `lastMessage` of each
 * unread DM conversation.
 *
 * This is summary-only: it cannot recover earlier unread DMs (when
 * `unreadCount > 1`) or unread channel posts that did not mention us. Use
 * {@link collectInboxMessages} to hydrate those from the messages APIs.
 *
 * Defensive against a null/partial payload: the engine contract guarantees the
 * arrays, but treat anything missing or non-array as empty rather than throwing
 * inside an idle poll.
 */
export function inboxToMessages(inbox: InboxResponse | null | undefined): RelayMessage[] {
  const messages: RelayMessage[] = [];

  const mentions = Array.isArray(inbox?.mentions) ? inbox.mentions : [];
  for (const mention of mentions) {
    messages.push({
      id: mention.id,
      from: mention.agentName,
      text: mention.text,
      channel: mention.channelName,
      ts: mention.createdAt,
    });
  }

  const unreadDms = Array.isArray(inbox?.unreadDms) ? inbox.unreadDms : [];
  for (const dm of unreadDms) {
    if (!dm.lastMessage) {
      continue;
    }
    messages.push({
      id: dm.lastMessage.id,
      from: dm.from,
      text: dm.lastMessage.text,
      ts: dm.lastMessage.createdAt,
    });
  }

  return messages;
}

/** Best-effort hydration of a multi-message DM conversation's unread tail. */
async function fetchUnreadDmMessages(
  agent: AgentClient,
  conversationId: string,
  from: string,
  unreadCount: number
): Promise<RelayMessage[]> {
  const limit = Math.min(unreadCount, MAX_UNREAD_FETCH);
  let dmMessages: DmMessage[];
  try {
    dmMessages = await agent.dms.messages(conversationId, { limit });
  } catch {
    return [];
  }
  if (!Array.isArray(dmMessages)) {
    return [];
  }
  // `dms.messages` returns newest-first; take the unread tail and restore
  // chronological order so multi-message instructions read top-to-bottom.
  return dmMessages
    .slice(0, limit)
    .reverse()
    .map((message) => ({
      id: message.id,
      from: message.agentName ?? from,
      text: message.text,
      ts: message.createdAt,
    }));
}

/** Best-effort hydration of unread posts in a channel we are not mentioned in. */
async function fetchUnreadChannelMessages(
  agent: AgentClient,
  channelName: string,
  unreadCount: number
): Promise<RelayMessage[]> {
  const limit = Math.min(unreadCount, MAX_UNREAD_FETCH);
  let channelMessages: MessageWithMeta[];
  try {
    channelMessages = await agent.messages(channelName, { limit });
  } catch {
    return [];
  }
  if (!Array.isArray(channelMessages)) {
    return [];
  }
  return channelMessages
    .slice(0, limit)
    .reverse()
    .map((message) => ({
      id: message.id,
      from: message.agentName,
      text: message.text,
      channel: channelName,
      ts: message.createdAt,
    }));
}

/**
 * Build the flat, ordered list of *new* inbox messages and drain them, faithfully
 * replicating the old `/inbox/check` queue behavior on top of the read-only
 * engine inbox summary:
 *
 *  - Channel `mentions` and unread-DM `lastMessage`s come straight from the
 *    summary (as in {@link inboxToMessages}).
 *  - Multi-message DM conversations (`unreadCount > 1`) and unread channel posts
 *    that did not mention us are hydrated from the DM / channel message APIs so
 *    earlier instructions and non-mention channel traffic are not dropped.
 *  - Every surfaced message is drained: recorded in `state.seenMessageIds`
 *    (so it is never re-injected) and `markRead`-acked on the engine
 *    (best-effort) so the summary stops reporting it as unread.
 */
export async function collectInboxMessages(
  agent: AgentClient,
  inbox: InboxResponse | null | undefined,
  seen: Set<string>
): Promise<RelayMessage[]> {
  const collected: RelayMessage[] = [];
  const seenInBatch = new Set<string>();

  const push = (message: RelayMessage): void => {
    if (!message.id || seenInBatch.has(message.id)) {
      return;
    }
    seenInBatch.add(message.id);
    collected.push(message);
  };

  const mentions = Array.isArray(inbox?.mentions) ? inbox.mentions : [];
  for (const mention of mentions) {
    push({
      id: mention.id,
      from: mention.agentName,
      text: mention.text,
      channel: mention.channelName,
      ts: mention.createdAt,
    });
  }

  const unreadDms = Array.isArray(inbox?.unreadDms) ? inbox.unreadDms : [];
  for (const dm of unreadDms) {
    if ((dm.unreadCount ?? 0) > 1 && dm.conversationId) {
      const hydrated = await fetchUnreadDmMessages(agent, dm.conversationId, dm.from, dm.unreadCount);
      if (hydrated.length > 0) {
        for (const message of hydrated) {
          push(message);
        }
        continue;
      }
    }
    if (dm.lastMessage) {
      push({
        id: dm.lastMessage.id,
        from: dm.from,
        text: dm.lastMessage.text,
        ts: dm.lastMessage.createdAt,
      });
    }
  }

  const unreadChannels = Array.isArray(inbox?.unreadChannels) ? inbox.unreadChannels : [];
  for (const channel of unreadChannels) {
    if (!channel.channelName || (channel.unreadCount ?? 0) <= 0) {
      continue;
    }
    const hydrated = await fetchUnreadChannelMessages(agent, channel.channelName, channel.unreadCount);
    for (const message of hydrated) {
      push(message);
    }
  }

  // Drain: drop anything already surfaced, then watermark + ack the rest.
  const fresh = collected.filter((message) => !seen.has(message.id));
  for (const message of fresh) {
    seen.add(message.id);
  }
  await Promise.all(
    fresh.map(async (message) => {
      try {
        await agent.markRead(message.id);
      } catch {
        // Best-effort: the local watermark already prevents re-injection.
      }
    })
  );

  return fresh;
}

export function createRelayConnectTool(
  state: RelayState,
  dependencies: ToolDependencies = {}
): ToolDefinition<RelayConnectInput, { ok: true; name: string; workspace: string }> {
  const createRelayCast = dependencies.createRelayCast ?? defaultCreateRelayCast;

  return {
    name: 'relay_connect',
    description: 'Connect to an Agent Relay workspace. Call this first.',
    schema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace key (rk_live_...)',
        },
        name: {
          type: 'string',
          description: 'Your agent name on the relay',
        },
      },
      required: ['workspace', 'name'],
    },
    async handler({ workspace, name }) {
      if (!workspace.startsWith('rk_live_')) {
        throw new Error('Invalid workspace key. Get one at relaycast.dev');
      }

      const relay = createRelayCast({ apiKey: workspace, baseUrl: state.apiBaseUrl });

      let token: string | undefined;
      try {
        // Register (or rotate) this agent identity in the workspace and obtain
        // its agent token; this is the SDK equivalent of the old /register call.
        const registration = await relay.registerOrRotate({ name });
        token = registration?.token;
      } catch (error) {
        if (isAuthError(error)) {
          throw new Error('Invalid workspace key. Get one at relaycast.dev');
        }
        throw error;
      }

      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Relay API error: register response missing token');
      }

      state.workspace = workspace;
      state.agentName = name;
      state.token = token;
      state.relay = relay;
      state.agent = relay.as(token);
      state.connected = true;

      return {
        ok: true,
        name,
        workspace: `${workspace.slice(0, 12)}...`,
      };
    },
  };
}

export function createRelaySendTool(
  state: RelayState
): ToolDefinition<RelaySendInput, { sent: true; to: string }> {
  return {
    name: 'relay_send',
    description: 'Send a direct message to another agent on the relay.',
    schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent name' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'text'],
    },
    async handler({ to, text }) {
      assertConnected(state);
      await state.agent.dm(to, text);
      return { sent: true, to };
    },
  };
}

export function createRelayInboxTool(
  state: RelayState
): ToolDefinition<EmptyInput, { count: number; messages: Message[] }> {
  return {
    name: 'relay_inbox',
    description: 'Check your inbox for new messages from other agents.',
    schema: { type: 'object', properties: {} },
    async handler() {
      assertConnected(state);
      const inbox = await state.agent.inbox();
      const messages = await collectInboxMessages(state.agent, inbox, state.seenMessageIds);
      return { count: messages.length, messages };
    },
  };
}

export function createRelayAgentsTool(state: RelayState): ToolDefinition<EmptyInput, { agents: unknown[] }> {
  return {
    name: 'relay_agents',
    description: 'List all agents currently on the relay.',
    schema: { type: 'object', properties: {} },
    async handler() {
      assertConnected(state);
      const agents = await state.relay.agents.list();
      return { agents };
    },
  };
}

export function createRelayPostTool(
  state: RelayState
): ToolDefinition<RelayPostInput, { posted: true; channel: string }> {
  return {
    name: 'relay_post',
    description: 'Post a message to a relay channel.',
    schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['channel', 'text'],
    },
    async handler({ channel, text }) {
      assertConnected(state);
      await state.agent.post(channel, text);
      return { posted: true, channel };
    },
  };
}

export function createRelaySpawnTool(
  state: RelayState,
  dependencies: ToolDependencies = {}
): ToolDefinition<RelaySpawnInput, { spawned: true; name: string; pid: number | null; hint: string }> {
  const spawnProcess = dependencies.spawn ?? spawn;

  return {
    name: 'relay_spawn',
    description:
      'Spawn a new OpenCode instance as a worker agent on the relay. ' +
      'The worker runs independently and can communicate with any agent.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker agent name' },
        task: { type: 'string', description: 'Task for the worker' },
        dir: {
          type: 'string',
          description: 'Working directory (defaults to current)',
        },
        model: {
          type: 'string',
          description: 'Model override (e.g., "claude-sonnet-4-6")',
        },
      },
      required: ['name', 'task'],
    },
    async handler({ name, task, dir, model }) {
      assertConnected(state);

      // Register the worker identity in the workspace so it shows up on the
      // relay before the local OpenCode process bootstraps and connects.
      // (The engine's agents.spawn requires a fixed cli enum that excludes
      // "opencode", so we register the identity and spawn the process locally.)
      await state.relay.agents.registerOrGet({
        name,
        metadata: { cli: 'opencode', task },
      });

      const systemPrompt = [
        `You are ${name}, a worker agent on Agent Relay.`,
        `Your task: ${task}`,
        '',
        'IMPORTANT: At the start, call relay_connect with:',
        '  workspace: (read from RELAY_WORKSPACE env var)',
        `  name: "${name}"`,
        '',
        `Then send a DM to "${state.agentName}" with "ACK: <your understanding of the task>".`,
        `When done, send "DONE: <summary>" to "${state.agentName}".`,
      ].join('\n');

      const args: string[] = ['--prompt', systemPrompt];
      if (dir) {
        args.push('--dir', dir);
      }
      if (model) {
        args.push('--model', model);
      }

      const proc = spawnProcess('opencode', args, {
        cwd: dir ?? process.cwd(),
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          RELAY_WORKSPACE: state.workspace,
          RELAY_AGENT_NAME: name,
        },
      });

      state.spawned.set(name, {
        name,
        process: proc,
        task,
        status: 'running',
      });

      proc.on('exit', (code) => {
        const agent = state.spawned.get(name);
        if (agent) {
          agent.status = code === 0 ? 'done' : 'error';
        }
      });

      return {
        spawned: true,
        name,
        pid: proc.pid ?? null,
        hint: `Worker "${name}" is starting. It will ACK via DM when ready.`,
      };
    },
  };
}

export function createRelayDismissTool(
  state: RelayState
): ToolDefinition<RelayDismissInput, { dismissed: true; name: string }> {
  return {
    name: 'relay_dismiss',
    description: 'Stop and release a spawned worker agent.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker name to dismiss' },
      },
      required: ['name'],
    },
    async handler({ name }) {
      assertConnected(state);

      const agent = state.spawned.get(name);
      if (agent && agent.status === 'running') {
        agent.process.kill('SIGTERM');
      }

      await state.relay.agents.delete(name);
      state.spawned.delete(name);
      return { dismissed: true, name };
    },
  };
}

export function createRelayTools(
  state: RelayState,
  dependencies: ToolDependencies = {}
): [
  ToolDefinition<RelayConnectInput, { ok: true; name: string; workspace: string }>,
  ToolDefinition<RelaySendInput, { sent: true; to: string }>,
  ToolDefinition<EmptyInput, { count: number; messages: Message[] }>,
  ToolDefinition<EmptyInput, { agents: unknown[] }>,
  ToolDefinition<RelayPostInput, { posted: true; channel: string }>,
  ToolDefinition<RelaySpawnInput, { spawned: true; name: string; pid: number | null; hint: string }>,
  ToolDefinition<RelayDismissInput, { dismissed: true; name: string }>,
] {
  return [
    createRelayConnectTool(state, dependencies),
    createRelaySendTool(state),
    createRelayInboxTool(state),
    createRelayAgentsTool(state),
    createRelayPostTool(state),
    createRelaySpawnTool(state, dependencies),
    createRelayDismissTool(state),
  ];
}

export function registerTools(
  ctx: ToolContext,
  state: RelayState,
  dependencies: ToolDependencies = {}
): void {
  for (const tool of createRelayTools(state, dependencies)) {
    ctx.tool(tool);
  }
}

function isAuthError(error: unknown): boolean {
  if (error instanceof RelayError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.code === 'unauthorized' ||
      error.code === 'agent_token_invalid' ||
      error.code === 'workspace_mismatch'
    );
  }
  return false;
}
