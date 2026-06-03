import type {
  RelayMessaging,
  RelayMessage,
  RelayMessageReaction,
  RelayAgentRegistration,
  RelayAgentType,
  RelayMessageAttachmentInput,
  RelayMessageBlock,
  RelayMessageMode,
  RelaySendChannelMessageInput,
  RelayWorkspaceInfo,
} from './messaging/index.js';
import type {
  AgentRelayActions,
  ActionContext,
  ActionHandle,
  ActionPolicy,
  ActionSchema,
} from './actions/index.js';
import type { DeliveryMode } from './delivery/index.js';
import type { RelayAgentHandle } from './listeners.js';

/**
 * A reference to an agent accepted by the high-level facade APIs. Agents may be
 * passed as a bare name/handle string, or as an object carrying any of
 * `name`, `handle`, `id`, and (for acting-as sends) `token`.
 */
export interface AgentRef {
  name?: string;
  handle?: string;
  id?: string;
  token?: string;
  type?: RelayAgentType;
  persona?: string;
  metadata?: Record<string, unknown>;
}

export type AgentLike = string | AgentRef;

/** Resolve an agent reference to its bare name (sigils such as `@`/`#` stripped). */
export function resolveAgentName(ref: AgentLike): string {
  if (typeof ref === 'string') return stripSigil(ref);
  const value = ref.handle ?? ref.name ?? ref.id;
  if (!value) {
    throw new Error('Unable to resolve agent name: reference has no name, handle, or id.');
  }
  return stripSigil(value);
}

/** Resolve an agent reference to its auth token, when one is available (for acting-as sends). */
export function resolveAgentToken(ref: AgentLike | undefined): string | undefined {
  return ref && typeof ref !== 'string' ? ref.token : undefined;
}

function stripSigil(value: string): string {
  return value.startsWith('@') || value.startsWith('#') ? value.slice(1) : value;
}

function isChannelTarget(to: string): boolean {
  return to.startsWith('#');
}

function deliveryToMode(delivery: DeliveryMode | undefined): RelayMessageMode | undefined {
  if (!delivery) return undefined;
  // `immediate` / `next-tool-call` interrupt the running agent; the rest queue.
  return delivery === 'immediate' || delivery === 'next-tool-call' ? 'steer' : 'wait';
}

function buildText(text: string | undefined, mentions: AgentLike[] | undefined): string {
  let body = text ?? '';
  if (mentions?.length) {
    const handles = mentions.map((mention) => `@${resolveAgentName(mention)}`);
    const missing = handles.filter((handle) => !body.includes(handle));
    if (missing.length) {
      body = body ? `${missing.join(' ')} ${body}` : missing.join(' ');
    }
  }
  return body;
}

/** Resolve a `thread`/`messageId` reference to a parent message id. */
function resolveMessageId(ref: string | { id?: string; threadId?: string } | undefined): string {
  if (!ref) {
    throw new Error('reply requires a `messageId` or `thread`.');
  }
  if (typeof ref === 'string') return ref;
  const value = ref.id ?? ref.threadId;
  if (!value) {
    throw new Error('Unable to resolve a message id from the provided thread reference.');
  }
  return value;
}

export interface RelaySendMessageInput {
  to: string;
  from?: AgentLike;
  text?: string;
  /** README shorthand for `text`. */
  msg?: string;
  mentions?: AgentLike[];
  mode?: RelayMessageMode;
  attachments?: RelayMessageAttachmentInput[];
  blocks?: RelayMessageBlock[];
  idempotencyKey?: string;
}

export interface RelayReplyInput {
  messageId?: string;
  thread?: string | { id?: string; threadId?: string };
  from?: AgentLike;
  text: string;
  blocks?: RelayMessageBlock[];
  idempotencyKey?: string;
}

export interface RelayReactInput {
  message: string | { id: string };
  agent?: AgentLike;
  emoji: string;
}

export interface RelayDirectInput {
  to: string;
  from?: AgentLike;
  text?: string;
  msg?: string;
  attachments?: RelayMessageAttachmentInput[];
  mode?: RelayMessageMode;
  idempotencyKey?: string;
}

/** Messaging surface plus the high-level overloads documented in the README. */
export type EnrichedMessages = RelayMessaging['messages'] & {
  send(input: RelaySendChannelMessageInput | RelaySendMessageInput): Promise<RelayMessage>;
  reply(input: RelayReplyInput): Promise<RelayMessage>;
  react(input: RelayReactInput): Promise<RelayMessageReaction>;
  react(messageId: string, emoji: string): Promise<RelayMessageReaction>;
  dm(input: RelayDirectInput): Promise<RelayMessage>;
};

/** Emoji reaction input on the live agent client. */
export interface RelayClientReactInput {
  messageId: string;
  emoji: string;
}

/**
 * A live, registered agent. Returned by `relay.workspace.register(...)` /
 * `reconnect(...)` and by harness `create(...)`. Carries the agent's identity
 * and status/tool predicate builders alongside a messaging surface scoped to
 * that agent.
 */
export interface RelayAgentClient extends RelayAgentHandle {
  readonly agents: RelayMessaging['agents'];
  readonly channels: RelayMessaging['channels'];
  readonly messages: EnrichedMessages;
  readonly threads: RelayMessaging['threads'];
  readonly inbox: RelayMessaging['inbox'];
  sendMessage(input: RelaySendMessageInput): Promise<RelayMessage>;
  reply(input: RelayReplyInput): Promise<RelayMessage>;
  react(input: RelayClientReactInput): Promise<RelayMessageReaction>;
}

/** Dependencies that let the workspace facade mint live agent clients. */
export interface WorkspaceFacadeDeps {
  buildAgentClient(registration: RelayAgentRegistration): RelayAgentClient;
  reconnectAgent(apiToken: string): Promise<RelayAgentClient>;
}

export interface RelayWorkspace {
  register<T extends AgentLike | AgentLike[]>(
    agents: T
  ): Promise<T extends AgentLike[] ? RelayAgentClient[] : RelayAgentClient>;
  reconnect(input: { apiToken: string }): Promise<RelayAgentClient>;
  info(): Promise<RelayWorkspaceInfo>;
}

export interface NotifyOptions {
  type?: string;
  action?: string;
  subject?: AgentLike;
  delivery?: DeliveryMode;
  text?: string;
}

export type NotifyHandler = (event?: unknown) => Promise<void>;

export interface RegisterActionInput<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  input?: ActionSchema<TInput>;
  inputSchema?: ActionSchema<TInput>;
  output?: ActionSchema<TOutput>;
  outputSchema?: ActionSchema<TOutput>;
  visibility?: 'agent' | 'human' | 'internal';
  /** Restrict which agents may invoke this action. Omit to allow everyone. */
  availableTo?: AgentLike[];
  policy?: ActionPolicy;
  handler(args: {
    input: TInput;
    agent: ActionContext['caller'];
    ctx: ActionContext;
  }): Promise<TOutput> | TOutput;
}

/**
 * Resolves the messaging client to act through for a given `from` agent. When
 * the agent carries a token, sends are attributed to that agent; otherwise the
 * default (workspace) messaging client is used.
 */
export type MessagingResolver = (from: AgentLike | undefined) => RelayMessaging['messages'];

export function createEnrichedMessages(
  base: RelayMessaging['messages'],
  resolveFrom: MessagingResolver
): EnrichedMessages {
  const enriched: EnrichedMessages = Object.create(base) as EnrichedMessages;

  enriched.send = (input: RelaySendChannelMessageInput | RelaySendMessageInput) => {
    if ('channel' in input && input.channel) {
      return base.send(input);
    }
    const sendInput = input as RelaySendMessageInput;
    const messages = resolveFrom(sendInput.from);
    const text = buildText(sendInput.text ?? sendInput.msg, sendInput.mentions);
    if (isChannelTarget(sendInput.to)) {
      return messages.send({
        channel: stripSigil(sendInput.to),
        text,
        blocks: sendInput.blocks,
        attachments: sendInput.attachments,
        mode: sendInput.mode,
        idempotencyKey: sendInput.idempotencyKey,
      });
    }
    return messages.direct({
      to: resolveAgentName(sendInput.to),
      text,
      attachments: sendInput.attachments,
      mode: sendInput.mode,
      idempotencyKey: sendInput.idempotencyKey,
    });
  };

  enriched.reply = (input: RelayReplyInput) => {
    const messages = resolveFrom(input.from);
    return messages.reply({
      messageId: resolveMessageId(input.messageId ?? input.thread),
      text: input.text,
      blocks: input.blocks,
      idempotencyKey: input.idempotencyKey,
    });
  };

  enriched.react = ((arg1: string | RelayReactInput, arg2?: string): Promise<RelayMessageReaction> => {
    if (typeof arg1 === 'string') {
      return base.react(arg1, arg2 as string);
    }
    const messageId = typeof arg1.message === 'string' ? arg1.message : arg1.message.id;
    const messages = resolveFrom(arg1.agent);
    return messages.react(messageId, arg1.emoji);
  }) as EnrichedMessages['react'];

  enriched.dm = (input: RelayDirectInput) => {
    const messages = resolveFrom(input.from);
    return messages.direct({
      to: resolveAgentName(input.to),
      text: input.text ?? input.msg ?? '',
      attachments: input.attachments,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
    });
  };

  return enriched;
}

export function createWorkspaceFacade(
  messaging: RelayMessaging,
  deps?: WorkspaceFacadeDeps
): RelayWorkspace {
  const register = async (agents: AgentLike | AgentLike[]): Promise<RelayAgentClient | RelayAgentClient[]> => {
    if (!deps) {
      throw new Error('register() is only available on the workspace client.');
    }
    const list = Array.isArray(agents) ? agents : [agents];
    const clients: RelayAgentClient[] = [];
    for (const agent of list) {
      const input =
        typeof agent === 'string'
          ? { name: stripSigil(agent) }
          : {
              name: resolveAgentName(agent),
              type: agent.type,
              persona: agent.persona,
              metadata: agent.metadata,
            };
      clients.push(deps.buildAgentClient(await messaging.agents.register(input)));
    }
    return Array.isArray(agents) ? clients : clients[0];
  };

  return {
    info: () => messaging.workspace.info(),
    register: register as RelayWorkspace['register'],
    reconnect: ({ apiToken }) => {
      if (!deps) {
        throw new Error('reconnect() is only available on the workspace client.');
      }
      return deps.reconnectAgent(apiToken);
    },
  };
}

export function registerFacadeAction<TInput, TOutput>(
  actions: AgentRelayActions,
  def: RegisterActionInput<TInput, TOutput>
): ActionHandle {
  const allowed = def.availableTo?.map(resolveAgentName);
  const policy: ActionPolicy | undefined =
    allowed || def.policy
      ? async (input, ctx) => {
          if (allowed && !allowed.includes(ctx.caller.name)) {
            return {
              allowed: false,
              reason: `${ctx.caller.name} is not permitted to call ${def.name}.`,
            };
          }
          return def.policy ? def.policy(input, ctx) : { allowed: true };
        }
      : undefined;

  return actions.register<TInput, TOutput>({
    name: def.name,
    description: def.description,
    input: def.input,
    inputSchema: def.inputSchema,
    output: def.output,
    outputSchema: def.outputSchema,
    visibility: def.visibility,
    policy,
    handler: (input, ctx) => def.handler({ input, agent: ctx.caller, ctx }),
  });
}

export function createNotifyHandler(
  messages: EnrichedMessages,
  target: AgentLike,
  options: NotifyOptions
): NotifyHandler {
  return async () => {
    const subject = options.subject ? `@${resolveAgentName(options.subject)}` : undefined;
    const label = options.type ?? options.action ?? 'notification';
    const text = options.text ?? [`[${label}]`, subject].filter(Boolean).join(' ');
    await messages.dm({
      to: resolveAgentName(target),
      text,
      mode: deliveryToMode(options.delivery),
    });
  };
}
