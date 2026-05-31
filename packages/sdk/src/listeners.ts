import type { ActionListenerEvent } from './actions/index.js';
import { resolveAgentName, type AgentLike } from './facade.js';
import type {
  RelayMessageCreatedEvent,
  RelayMessageReadEvent,
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

  subscribe(
    context: ListenerContext,
    handler: ListenerHandler<RelayMessageCreatedEvent>
  ): () => void {
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
// Listener hub — binds the messaging, action, and session event sources
// ---------------------------------------------------------------------------

export interface ActionEventSource {
  onEvent?(handler: (event: ActionListenerEvent) => void): () => void;
}

export interface ListenerHub {
  readonly events: EnrichedEvents;
  on<TEvent>(predicate: ListenerPredicate<TEvent>, handler: ListenerHandler<TEvent>): () => void;
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

  return {
    events,
    on: (predicate, handler) => predicate.subscribe(context, handler),
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
