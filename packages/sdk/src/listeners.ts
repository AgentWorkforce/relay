import type { ActionListenerEvent } from './actions/index.js';
import { resolveAgentName, type AgentLike } from './facade.js';
import type {
  RelayMessage,
  RelayMessageChannelRef,
  RelayMessageCreatedEvent,
  RelayMessageReadEvent,
  RelayMessageSender,
  RelayMessageTarget,
  RelayMessagingEvent,
  RelayMessagingEventsSurface,
  RelayReactionEvent,
} from './messaging/index.js';
import type { AgentSessionEvent, AgentSessionStatus } from './session/index.js';

/** A session event tagged with the id of the agent that produced it. */
export interface SessionListenerEnvelope {
  agentId: string;
  event: AgentSessionEvent;
}

/** Wiring handed to a predicate when `relay.on(...)` subscribes it. */
export interface ListenerContext {
  events: RelayMessagingEventsSurface;
  onActionEvent(handler: (event: ActionListenerEvent) => void): () => void;
  onSessionEvent(handler: (envelope: SessionListenerEnvelope) => void): () => void;
}

export type ListenerHandler<TEvent = unknown> = (event: TEvent) => void | Promise<void>;

export interface ListenerPredicate<TEvent = unknown> {
  subscribe(context: ListenerContext, handler: ListenerHandler<TEvent>): () => void;
}

function stripSigil(value: string): string {
  return value.startsWith('@') || value.startsWith('#') ? value.slice(1) : value;
}

function runHandler<TEvent>(handler: ListenerHandler<TEvent>, event: TEvent): void {
  void Promise.resolve(handler(event)).catch(() => {
    // Listener handler errors are isolated from the event source.
  });
}

// ---------------------------------------------------------------------------
// Message predicates
// ---------------------------------------------------------------------------

export class MessageCreatedPredicate implements ListenerPredicate<RelayMessageCreatedEvent> {
  private channel?: string;
  private mentioned?: string;

  in(channel: string): this {
    this.channel = stripSigil(channel);
    return this;
  }

  mentions(agent: AgentLike): this {
    this.mentioned = resolveAgentName(agent);
    return this;
  }

  subscribe(context: ListenerContext, handler: ListenerHandler<RelayMessageCreatedEvent>): () => void {
    return context.events.on('messageCreated', (event) => {
      if (this.channel && stripSigil(event.channel) !== this.channel) return;
      if (this.mentioned && !messageMentions(event, this.mentioned)) return;
      runHandler(handler, event);
    });
  }
}

function messageMentions(event: RelayMessageCreatedEvent, name: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.some((mention) => stripSigil(mention) === name)) return true;
  return event.message.text?.includes(`@${name}`) ?? false;
}

export class MessageReadPredicate implements ListenerPredicate<RelayMessageReadEvent> {
  subscribe(context: ListenerContext, handler: ListenerHandler<RelayMessageReadEvent>): () => void {
    return context.events.on('messageRead', (event) => runHandler(handler, event));
  }
}

export class MessageReactedPredicate implements ListenerPredicate<RelayReactionEvent> {
  subscribe(context: ListenerContext, handler: ListenerHandler<RelayReactionEvent>): () => void {
    const off1 = context.events.on('reactionAdded', (event) => runHandler(handler, event));
    const off2 = context.events.on('reactionRemoved', (event) => runHandler(handler, event));
    return () => {
      off1();
      off2();
    };
  }
}

export interface MessageEventBuilders {
  created(): MessageCreatedPredicate;
  read(): MessageReadPredicate;
  reacted(): MessageReactedPredicate;
}

export interface EnrichedEvents extends RelayMessagingEventsSurface {
  message: MessageEventBuilders;
}

export function createEnrichedEvents(base: RelayMessagingEventsSurface): EnrichedEvents {
  const enriched = Object.create(base) as EnrichedEvents;
  enriched.message = {
    created: () => new MessageCreatedPredicate(),
    read: () => new MessageReadPredicate(),
    reacted: () => new MessageReactedPredicate(),
  };
  return enriched;
}

// ---------------------------------------------------------------------------
// Action predicates
// ---------------------------------------------------------------------------

export class ActionPredicate implements ListenerPredicate<ActionListenerEvent> {
  private caller?: string;
  private phase: ActionListenerEvent['type'] = 'action.invoked';

  constructor(private readonly action: string) {}

  calledBy(agent: AgentLike): this {
    this.caller = resolveAgentName(agent);
    return this;
  }

  completed(): this {
    this.phase = 'action.completed';
    return this;
  }

  failed(): this {
    this.phase = 'action.failed';
    return this;
  }

  denied(): this {
    this.phase = 'action.denied';
    return this;
  }

  subscribe(context: ListenerContext, handler: ListenerHandler<ActionListenerEvent>): () => void {
    return context.onActionEvent((event) => {
      if (event.action !== this.action) return;
      if (event.type !== this.phase) return;
      if (this.caller && event.caller.name !== this.caller) return;
      runHandler(handler, event);
    });
  }
}

// ---------------------------------------------------------------------------
// Typed action events + handle predicates
// ---------------------------------------------------------------------------

/**
 * Shared shape of the typed action events delivered by the predicates on a
 * {@link TypedActionHandle}. Mirrors the public {@link RelayActionEvent} (the
 * caller surfaces as `agent`), with `input`/`output` carrying the generics
 * captured at `registerAction(...)` time instead of `unknown`.
 */
export interface TypedActionEventBase<TInput = unknown> {
  action: string;
  agent: ActionListenerEvent['caller'];
  input?: TInput;
  at: string;
}

export interface ActionInvokedEvent<TInput = unknown> extends TypedActionEventBase<TInput> {
  type: 'action.invoked';
}

export interface ActionCompletedEvent<TInput = unknown, TOutput = unknown>
  extends TypedActionEventBase<TInput> {
  type: 'action.completed';
  /** The handler's return value, typed from the `output` schema (or the handler's return type). */
  output: TOutput;
}

export interface ActionFailedEvent<TInput = unknown> extends TypedActionEventBase<TInput> {
  type: 'action.failed';
  error: string;
}

export interface ActionDeniedEvent<TInput = unknown> extends TypedActionEventBase<TInput> {
  type: 'action.denied';
  reason?: string;
}

/**
 * A phase-bound action predicate carrying the event type captured at
 * registration. Built by the {@link TypedActionHandle} returned from
 * `relay.registerAction(...)`; behaves like {@link ActionPredicate} at runtime
 * but delivers a typed event, so handlers read `event.output` without casts.
 */
export class TypedActionPredicate<TEvent extends TypedActionEventBase>
  implements ListenerPredicate<TEvent>
{
  private caller?: string;

  constructor(
    private readonly action: string,
    private readonly phase: ActionListenerEvent['type']
  ) {}

  calledBy(agent: AgentLike): this {
    this.caller = resolveAgentName(agent);
    return this;
  }

  subscribe(context: ListenerContext, handler: ListenerHandler<TEvent>): () => void {
    return context.onActionEvent((event) => {
      if (event.action !== this.action) return;
      if (event.type !== this.phase) return;
      if (this.caller && event.caller.name !== this.caller) return;
      runHandler(handler, toTypedActionEvent(event) as unknown as TEvent);
    });
  }
}

/** Map a registry-level action event to the public shape (`caller` → `agent`). */
function toTypedActionEvent(raw: ActionListenerEvent): TypedActionEventBase & { type: string } {
  return {
    type: raw.type,
    action: raw.action,
    agent: raw.caller,
    ...(raw.input !== undefined ? { input: raw.input } : {}),
    ...(raw.output !== undefined ? { output: raw.output } : {}),
    ...(raw.error !== undefined ? { error: raw.error } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    at: raw.at,
  };
}

/**
 * Handle returned by `relay.registerAction(...)`. Alongside `unregister()` it
 * exposes typed predicate builders bound to the registered action, so result
 * subscriptions keep the registration's `input`/`output` types:
 *
 * ```ts
 * const handle = relay.registerAction({ name: 'score', input, output, handler });
 * relay.addListener(handle.completed(), (event) => event.output); // typed, no cast
 * relay.addListener(handle.failed(), (event) => event.error);
 * ```
 */
export interface TypedActionHandle<TInput = unknown, TOutput = unknown> {
  /** The registered action name. */
  readonly name: string;
  unregister(): void;
  invoked(): TypedActionPredicate<ActionInvokedEvent<TInput>>;
  completed(): TypedActionPredicate<ActionCompletedEvent<TInput, TOutput>>;
  failed(): TypedActionPredicate<ActionFailedEvent<TInput>>;
  denied(): TypedActionPredicate<ActionDeniedEvent<TInput>>;
}

export function createTypedActionHandle<TInput, TOutput>(
  name: string,
  unregister: () => void
): TypedActionHandle<TInput, TOutput> {
  return {
    name,
    unregister,
    invoked: () => new TypedActionPredicate<ActionInvokedEvent<TInput>>(name, 'action.invoked'),
    completed: () =>
      new TypedActionPredicate<ActionCompletedEvent<TInput, TOutput>>(name, 'action.completed'),
    failed: () => new TypedActionPredicate<ActionFailedEvent<TInput>>(name, 'action.failed'),
    denied: () => new TypedActionPredicate<ActionDeniedEvent<TInput>>(name, 'action.denied'),
  };
}

// ---------------------------------------------------------------------------
// Agent session predicates (status + tools)
// ---------------------------------------------------------------------------

export class StatusPredicate implements ListenerPredicate<AgentSessionEvent> {
  constructor(
    private readonly agentId: string,
    private readonly status: AgentSessionStatus
  ) {}

  subscribe(context: ListenerContext, handler: ListenerHandler<AgentSessionEvent>): () => void {
    return context.onSessionEvent(({ agentId, event }) => {
      if (agentId !== this.agentId) return;
      const matches =
        (event.type === 'status.changed' && event.status === this.status) ||
        event.type === `status.${this.status}`;
      if (matches) runHandler(handler, event);
    });
  }
}

type ToolCalledEvent = Extract<AgentSessionEvent, { type: 'tool.called' }>;

export class ToolCalledPredicate implements ListenerPredicate<ToolCalledEvent> {
  private filter?: (event: ToolCalledEvent) => boolean;

  constructor(
    private readonly agentId: string,
    private readonly tool: string
  ) {}

  where(filter: (event: ToolCalledEvent) => boolean): this {
    this.filter = filter;
    return this;
  }

  subscribe(context: ListenerContext, handler: ListenerHandler<ToolCalledEvent>): () => void {
    return context.onSessionEvent(({ agentId, event }) => {
      if (agentId !== this.agentId) return;
      if (event.type !== 'tool.called' || event.tool !== this.tool) return;
      if (this.filter && !this.filter(event)) return;
      runHandler(handler, event);
    });
  }
}

export interface AgentStatusBuilders {
  becomes(status: AgentSessionStatus): StatusPredicate;
}

export interface AgentToolBuilders {
  called(tool: string): ToolCalledPredicate;
}

/**
 * A live handle for an agent that carries its identity plus predicate builders
 * used with `relay.on(...)`. Returned by harness `create(...)` and `relay.agent(...)`.
 */
export interface RelayAgentHandle {
  id: string;
  name: string;
  handle: string;
  token?: string;
  status: AgentStatusBuilders;
  tools: AgentToolBuilders;
}

export interface AgentHandleInput {
  id: string;
  name: string;
  handle?: string;
  token?: string;
}

// ---------------------------------------------------------------------------
// Public event surface — addListener(name | predicate, handler)
// ---------------------------------------------------------------------------

/** Flat, ergonomic view of a message event's participants and location. */
export interface RelayEventEnvelope {
  from?: RelayMessageSender;
  to?: RelayMessageTarget;
  channel?: RelayMessageChannelRef;
  parent?: string;
}

export interface RelayMessageEvent {
  type: 'message.created' | 'message.updated' | 'thread.reply' | 'dm.received' | 'group_dm.received';
  message: RelayMessage;
  envelope: RelayEventEnvelope;
}

export interface RelayMessageReadEventPublic {
  type: 'message.read';
  messageId: string;
  agentName: string;
  readAt?: string;
}

export interface RelayMessageReactedEvent {
  type: 'message.reacted';
  messageId: string;
  emoji: string;
  agentName: string;
  action: 'added' | 'removed';
}

export interface RelayActionEvent {
  type: 'action.invoked' | 'action.completed' | 'action.failed' | 'action.denied';
  action: string;
  agent: ActionListenerEvent['caller'];
  input?: unknown;
  output?: unknown;
  error?: string;
  reason?: string;
  at: string;
}

export interface RelayAgentStatusEvent {
  type:
    | 'agent.status.changed'
    | 'agent.status.idle'
    | 'agent.status.active'
    | 'agent.status.blocked'
    | 'agent.status.waiting'
    | 'agent.status.offline';
  agentId: string;
  status?: AgentSessionStatus;
  reason?: string;
}

export interface RelaySessionEvent {
  type: string;
  agentId: string;
  event: AgentSessionEvent;
}

/** The discriminated event object delivered to every `addListener` handler. */
export type RelayEvent =
  | RelayMessageEvent
  | RelayMessageReadEventPublic
  | RelayMessageReactedEvent
  | RelayActionEvent
  | RelayAgentStatusEvent
  | RelaySessionEvent;

const PUBLIC_MESSAGE_TYPE: Partial<Record<RelayMessagingEvent['type'], RelayMessageEvent['type']>> = {
  messageCreated: 'message.created',
  messageUpdated: 'message.updated',
  threadReply: 'thread.reply',
  dmReceived: 'dm.received',
  groupDmReceived: 'group_dm.received',
};

function buildEnvelope(message: RelayMessage, channelName?: string): RelayEventEnvelope {
  const channel = message.channel ?? (channelName ? { name: stripSigil(channelName) } : undefined);
  return {
    ...(message.from ? { from: message.from } : {}),
    ...(message.target ? { to: message.target } : {}),
    ...(channel ? { channel } : {}),
    ...(message.parentId ? { parent: message.parentId } : {}),
  };
}

/** Map a raw messaging event to its public form, or `undefined` if not surfaced. */
export function toPublicMessagingEvent(raw: RelayMessagingEvent): RelayEvent | undefined {
  const messageType = PUBLIC_MESSAGE_TYPE[raw.type];
  if (messageType && 'message' in raw) {
    const channelName = 'channel' in raw && typeof raw.channel === 'string' ? raw.channel : undefined;
    return { type: messageType, message: raw.message, envelope: buildEnvelope(raw.message, channelName) };
  }
  if (raw.type === 'messageRead') {
    return {
      type: 'message.read',
      messageId: raw.messageId,
      agentName: raw.agentName,
      ...(raw.readAt ? { readAt: raw.readAt } : {}),
    };
  }
  if (raw.type === 'reactionAdded' || raw.type === 'reactionRemoved') {
    return {
      type: 'message.reacted',
      messageId: raw.messageId,
      emoji: raw.emoji,
      agentName: raw.agentName,
      action: raw.type === 'reactionAdded' ? 'added' : 'removed',
    };
  }
  return undefined;
}

function toPublicActionEvent(raw: ActionListenerEvent): RelayActionEvent {
  return {
    type: raw.type,
    action: raw.action,
    agent: raw.caller,
    input: raw.input,
    output: raw.output,
    error: raw.error,
    reason: raw.reason,
    at: raw.at,
  };
}

function toPublicSessionEvent(agentId: string, event: AgentSessionEvent): RelayEvent {
  if (event.type.startsWith('status.')) {
    return {
      type: `agent.${event.type}` as RelayAgentStatusEvent['type'],
      agentId,
      ...('status' in event && event.status ? { status: event.status } : {}),
      ...('reason' in event && event.reason ? { reason: event.reason } : {}),
    };
  }
  return { type: event.type, agentId, event };
}

/** Match a selector (`'*'`, `'message.*'`, or an exact dotted name) against an event type. */
export function matchesSelector(selector: string, type: string): boolean {
  if (selector === '*') return true;
  if (selector.endsWith('.*')) return type.startsWith(selector.slice(0, -1));
  return selector === type;
}

// ---------------------------------------------------------------------------
// Listener hub — binds the messaging, action, and session event sources
// ---------------------------------------------------------------------------

export interface ActionEventSource {
  onEvent?(handler: (event: ActionListenerEvent) => void): () => void;
}

export interface ListenerHub {
  readonly events: EnrichedEvents;
  on<TEvent>(predicate: ListenerPredicate<TEvent>, handler: ListenerHandler<TEvent>): () => void;
  /** Subscribe with a typed predicate — the handler receives the predicate's event type. */
  addListener<TEvent>(selector: ListenerPredicate<TEvent>, handler: ListenerHandler<TEvent>): () => void;
  /** Subscribe by dotted event name, `'*'`/prefix wildcard, or a predicate. */
  addListener(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void;
  action(name: string): ActionPredicate;
  agent(input: AgentHandleInput): RelayAgentHandle;
  /** Feed a harness session event into the hub so agent predicates can fire. */
  emitSessionEvent(agentId: string, event: AgentSessionEvent): void;
}

export function createListenerHub(
  baseEvents: RelayMessagingEventsSurface,
  actions: ActionEventSource
): ListenerHub {
  const sessionHandlers = new Set<(envelope: SessionListenerEnvelope) => void>();
  const events = createEnrichedEvents(baseEvents);

  const context: ListenerContext = {
    events: baseEvents,
    onActionEvent: (handler) => actions.onEvent?.(handler) ?? (() => {}),
    onSessionEvent: (handler) => {
      sessionHandlers.add(handler);
      return () => sessionHandlers.delete(handler);
    },
  };

  const addListener = (
    selector: string | ListenerPredicate,
    handler: ListenerHandler<RelayEvent>
  ): (() => void) => {
    // Open the event stream — `events.on(...)` only registers handlers; the
    // socket is opened by `events.connect()` (idempotent). Agent-scoped clients
    // stream through their own connection; workspace-key clients stream all
    // workspace-visible events through the workspace stream.
    try {
      context.events.connect();
    } catch {
      // No stream available (no agent token and no workspace stream).
    }
    if (typeof selector !== 'string') {
      return selector.subscribe(context, handler as ListenerHandler);
    }
    const offs = [
      context.events.on('any', (raw) => {
        const evt = toPublicMessagingEvent(raw);
        if (evt && matchesSelector(selector, evt.type)) runHandler(handler, evt);
      }),
      context.onActionEvent((raw) => {
        const evt = toPublicActionEvent(raw);
        if (matchesSelector(selector, evt.type)) runHandler(handler, evt);
      }),
      context.onSessionEvent(({ agentId, event }) => {
        const evt = toPublicSessionEvent(agentId, event);
        if (matchesSelector(selector, evt.type)) runHandler(handler, evt);
      }),
    ];
    return () => offs.forEach((off) => off());
  };

  return {
    events,
    on: (predicate, handler) => predicate.subscribe(context, handler),
    addListener,
    action: (name) => new ActionPredicate(name),
    agent: (input) => createAgentHandle(input),
    emitSessionEvent: (agentId, event) => {
      for (const handler of sessionHandlers) {
        try {
          handler({ agentId, event });
        } catch {
          // Session listener errors are isolated.
        }
      }
    },
  };
}

export function createAgentHandle(input: AgentHandleInput): RelayAgentHandle {
  const handle = input.handle ?? input.name;
  return {
    id: input.id,
    name: input.name,
    handle,
    token: input.token,
    status: {
      becomes: (status) => new StatusPredicate(input.id, status),
    },
    tools: {
      called: (tool) => new ToolCalledPredicate(input.id, tool),
    },
  };
}
