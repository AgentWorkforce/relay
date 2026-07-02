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
  /** Receives handler errors; defaults to a console warning when unset. */
  onError?: RelayErrorHook;
}

export type ListenerHandler<TEvent = unknown> = (event: TEvent) => void | Promise<void>;

export interface ListenerPredicate<TEvent = unknown> {
  subscribe(context: ListenerContext, handler: ListenerHandler<TEvent>): () => void;
}

/** Identifies the listener or action that produced a handler error. */
export interface RelayErrorContext {
  source: 'listener' | 'action';
  /** Selector string or predicate event name for listener errors. */
  selector?: string;
  /** Action name for action-related errors. */
  action?: string;
  /** The action wiring operation that failed (e.g. `register`, `complete_invocation`). */
  operation?: string;
}

/** Hook invoked when a listener or action handler throws. */
export type RelayErrorHook = (error: unknown, context: RelayErrorContext) => void;

/** Default reporting for handler errors when no `onError` hook is registered. */
export function logRelayHandlerError(error: unknown, context: RelayErrorContext): void {
  const where = context.action ? `action "${context.action}"` : `"${context.selector ?? 'unknown'}"`;
  console.warn(`[agent-relay] ${context.source} handler for ${where} threw:`, error);
}

function stripSigil(value: string): string {
  return value.startsWith('@') || value.startsWith('#') ? value.slice(1) : value;
}

function runHandler<TEvent>(
  handler: ListenerHandler<TEvent>,
  event: TEvent,
  report: (error: unknown) => void
): void {
  // Handler errors are isolated from the event source and surfaced through
  // the `onError` hook (or a console warning when no hook is registered).
  try {
    void Promise.resolve(handler(event)).catch(report);
  } catch (error) {
    report(error);
  }
}

/** Build an error reporter that routes through the context hook or the default log. */
function makeReporter(context: ListenerContext, info: RelayErrorContext): (error: unknown) => void {
  return (error) => {
    if (!context.onError) {
      logRelayHandlerError(error, info);
      return;
    }
    try {
      context.onError(error, info);
    } catch {
      // Error hooks must not throw into the event source.
    }
  };
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
    const report = makeReporter(context, { source: 'listener', selector: 'message.created' });
    return context.events.on('messageCreated', (event) => {
      if (this.channel && stripSigil(event.channel) !== this.channel) return;
      if (this.mentioned && !messageMentions(event, this.mentioned)) return;
      runHandler(handler, event, report);
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
    const report = makeReporter(context, { source: 'listener', selector: 'message.read' });
    return context.events.on('messageRead', (event) => runHandler(handler, event, report));
  }
}

export class MessageReactedPredicate implements ListenerPredicate<RelayReactionEvent> {
  subscribe(context: ListenerContext, handler: ListenerHandler<RelayReactionEvent>): () => void {
    const report = makeReporter(context, { source: 'listener', selector: 'message.reacted' });
    const off1 = context.events.on('reactionAdded', (event) => runHandler(handler, event, report));
    const off2 = context.events.on('reactionRemoved', (event) => runHandler(handler, event, report));
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
    const report = makeReporter(context, {
      source: 'listener',
      selector: this.phase,
      action: this.action,
    });
    return context.onActionEvent((event) => {
      if (event.action !== this.action) return;
      if (event.type !== this.phase) return;
      if (this.caller && event.caller.name !== this.caller) return;
      runHandler(handler, event, report);
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

export interface ActionCompletedEvent<
  TInput = unknown,
  TOutput = unknown,
> extends TypedActionEventBase<TInput> {
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
export class TypedActionPredicate<TEvent extends TypedActionEventBase> implements ListenerPredicate<TEvent> {
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
    const report = makeReporter(context, {
      source: 'listener',
      selector: this.phase,
      action: this.action,
    });
    return context.onActionEvent((event) => {
      if (event.action !== this.action) return;
      if (event.type !== this.phase) return;
      if (this.caller && event.caller.name !== this.caller) return;
      runHandler(handler, toTypedActionEvent(event) as unknown as TEvent, report);
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
    const report = makeReporter(context, {
      source: 'listener',
      selector: `agent.status.${this.status}`,
    });
    return context.onSessionEvent(({ agentId, event }) => {
      if (agentId !== this.agentId) return;
      const matches =
        (event.type === 'status.changed' && event.status === this.status) ||
        event.type === `status.${this.status}`;
      if (matches) runHandler(handler, event, report);
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
    const report = makeReporter(context, { source: 'listener', selector: `tool.called:${this.tool}` });
    return context.onSessionEvent(({ agentId, event }) => {
      if (agentId !== this.agentId) return;
      if (event.type !== 'tool.called' || event.tool !== this.tool) return;
      if (this.filter && !this.filter(event)) return;
      runHandler(handler, event, report);
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

export type RelayMessageEventType =
  | 'message.created'
  | 'message.updated'
  | 'thread.reply'
  | 'dm.received'
  | 'group_dm.received';

export interface RelayMessageEvent<TType extends RelayMessageEventType = RelayMessageEventType> {
  type: TType;
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

export type RelayActionEventType = 'action.invoked' | 'action.completed' | 'action.failed' | 'action.denied';

export interface RelayActionEvent<TType extends RelayActionEventType = RelayActionEventType> {
  type: TType;
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

/**
 * Maps exact dotted selectors to the event type their handlers receive.
 * Wildcard selectors (`'*'`, `'message.*'`) and arbitrary strings keep the
 * full {@link RelayEvent} union.
 */
export interface RelayEventMap {
  'message.created': RelayMessageEvent<'message.created'>;
  'message.updated': RelayMessageEvent<'message.updated'>;
  'thread.reply': RelayMessageEvent<'thread.reply'>;
  'dm.received': RelayMessageEvent<'dm.received'>;
  'group_dm.received': RelayMessageEvent<'group_dm.received'>;
  'message.read': RelayMessageReadEventPublic;
  'message.reacted': RelayMessageReactedEvent;
  'action.invoked': RelayActionEvent<'action.invoked'>;
  'action.completed': RelayActionEvent<'action.completed'>;
  'action.failed': RelayActionEvent<'action.failed'>;
  'action.denied': RelayActionEvent<'action.denied'>;
  'agent.status.changed': RelayAgentStatusEvent;
  'agent.status.idle': RelayAgentStatusEvent;
  'agent.status.active': RelayAgentStatusEvent;
  'agent.status.blocked': RelayAgentStatusEvent;
  'agent.status.waiting': RelayAgentStatusEvent;
  'agent.status.offline': RelayAgentStatusEvent;
}

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

export interface ListenerHubOptions {
  /** Receives listener handler errors; defaults to a console warning when unset. */
  onError?: RelayErrorHook;
}

export interface ListenerHub {
  readonly events: EnrichedEvents;
  on<TEvent>(predicate: ListenerPredicate<TEvent>, handler: ListenerHandler<TEvent>): () => void;
  /** Subscribe with a typed predicate — the handler receives the predicate's event type. */
  addListener<TEvent>(selector: ListenerPredicate<TEvent>, handler: ListenerHandler<TEvent>): () => void;
  /** Subscribe by dotted event name, `'*'`/prefix wildcard, or a predicate. */
  addListener<K extends keyof RelayEventMap>(
    selector: K,
    handler: ListenerHandler<RelayEventMap[K]>
  ): () => void;
  addListener(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void;
  /** Like `addListener`, but auto-unsubscribes after the first matching event. */
  once<K extends keyof RelayEventMap>(selector: K, handler: ListenerHandler<RelayEventMap[K]>): () => void;
  once(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void;
  action(name: string): ActionPredicate;
  agent(input: AgentHandleInput): RelayAgentHandle;
  /** Feed a harness session event into the hub so agent predicates can fire. */
  emitSessionEvent(agentId: string, event: AgentSessionEvent): void;
}

export function createListenerHub(
  baseEvents: RelayMessagingEventsSurface,
  actions: ActionEventSource,
  options?: ListenerHubOptions
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
    ...(options?.onError ? { onError: options.onError } : {}),
  };

  const addListener = (
    selector: string | ListenerPredicate,
    handler: ListenerHandler<RelayEvent>
  ): (() => void) => {
    // Open the event stream — `events.on(...)` only registers handlers; the
    // socket is opened by `events.connect()` (idempotent). Agent-scoped clients
    // stream through their own connection; the workspace-level hub streams
    // through registered agent clients via the events fan-in. A connect
    // failure must be surfaced, not swallowed: a listener attached to a
    // stream that never opens receives nothing, silently.
    try {
      context.events.connect();
    } catch (error) {
      makeReporter(context, {
        source: 'listener',
        selector: typeof selector === 'string' ? selector : 'predicate',
      })(error);
    }
    if (typeof selector !== 'string') {
      return selector.subscribe(context, handler as ListenerHandler);
    }
    const report = makeReporter(context, { source: 'listener', selector });
    const offs = [
      context.events.on('any', (raw) => {
        const evt = toPublicMessagingEvent(raw);
        if (evt && matchesSelector(selector, evt.type)) runHandler(handler, evt, report);
      }),
      context.onActionEvent((raw) => {
        const evt = toPublicActionEvent(raw);
        if (matchesSelector(selector, evt.type)) runHandler(handler, evt, report);
      }),
      context.onSessionEvent(({ agentId, event }) => {
        const evt = toPublicSessionEvent(agentId, event);
        if (matchesSelector(selector, evt.type)) runHandler(handler, evt, report);
      }),
    ];
    return () => offs.forEach((off) => off());
  };

  const once = (selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): (() => void) => {
    let done = false;
    let off: (() => void) | undefined;
    const wrapped: ListenerHandler<RelayEvent> = (event) => {
      if (done) return;
      done = true;
      off?.();
      return handler(event);
    };
    off = addListener(selector, wrapped);
    if (done) off();
    return () => {
      done = true;
      off?.();
    };
  };

  return {
    events,
    on: (predicate, handler) => predicate.subscribe(context, handler),
    addListener,
    once,
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
