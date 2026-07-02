import { RelayCast, RelayError } from '@relaycast/sdk';

import { ActionRegistry, type AgentRelayActions } from './actions/index.js';
import {
  relaycastTelemetryOptions,
  relaycastWorkspaceTelemetryOptions,
  type RelaycastTelemetryOptions,
} from './relaycast-telemetry.js';
import {
  createEventFanIn,
  RelaycastMessagingClient,
  type RelayAgentRegistration,
  type RelayEventFanIn,
  type RelayMessaging,
  type RelaycastMessagingOptions,
} from './messaging/index.js';
import {
  createEnrichedMessages,
  createWorkspaceFacade,
  registerFacadeAction,
  resolveAgentToken,
  type AgentLike,
  type EnrichedMessages,
  type MessagingResolver,
  type RegisterActionInput,
  type RelayAgentClient,
  type RelayWorkspace,
} from './facade.js';
import {
  createAgentHandle,
  createListenerHub,
  logRelayHandlerError,
  type AgentHandleInput,
  type ActionPredicate,
  type EnrichedEvents,
  type ListenerHandler,
  type ListenerHub,
  type ListenerPredicate,
  type RelayAgentHandle,
  type RelayErrorContext,
  type RelayErrorHook,
  type RelayEvent,
  type RelayEventMap,
  type TypedActionHandle,
} from './listeners.js';
import type { AgentSessionEvent } from './session/index.js';

export interface AgentRelayOptions extends RelaycastMessagingOptions {
  messaging?: RelayMessaging;
  actions?: AgentRelayActions;
  /** Factory for agent-token-scoped messaging clients. Defaults to a Relaycast client. */
  createAgentMessaging?: (token: string) => RelayMessaging;
  /**
   * Receives listener and action handler errors with a context identifying
   * the listener selector or action name. When unset, errors are logged as
   * console warnings.
   */
  onError?: RelayErrorHook;
}

export interface AgentRelayCreateWorkspaceInput extends RelaycastTelemetryOptions {
  name: string;
  baseUrl?: string;
  retryPolicy?: RelaycastMessagingOptions['retryPolicy'];
  actions?: AgentRelayActions;
}

export interface AgentRelayAgent {
  readonly messaging: RelayMessaging;
  readonly agents: RelayMessaging['agents'];
  readonly channels: RelayMessaging['channels'];
  readonly messages: EnrichedMessages;
  readonly threads: RelayMessaging['threads'];
  readonly inbox: RelayMessaging['inbox'];
  readonly events: RelayMessaging['events'];
  readonly deliveries: RelayMessaging['deliveries'];
  readonly integrations: RelayMessaging['integrations'];
  readonly webhooks: RelayMessaging['webhooks'];
  readonly capabilities: RelayMessaging['commands'];
  readonly nodes: RelayMessaging['nodes'];
  readonly triggers: RelayMessaging['triggers'];
  readonly workspace: RelayWorkspace;
  registerAction<TInput, TOutput>(
    def: RegisterActionInput<TInput, TOutput>
  ): TypedActionHandle<TInput, TOutput>;
  /** Subscribe with a typed predicate — the handler receives the predicate's event type. */
  addListener<TEvent>(selector: ListenerPredicate<TEvent>, handler: ListenerHandler<TEvent>): () => void;
  /** Subscribe by dotted event name, `'*'`/prefix wildcard, or a predicate. */
  addListener<K extends keyof RelayEventMap>(
    selector: K,
    handler: ListenerHandler<RelayEventMap[K]>
  ): () => void;
  addListener(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void;
  once<K extends keyof RelayEventMap>(selector: K, handler: ListenerHandler<RelayEventMap[K]>): () => void;
  once(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void;
  action(name: string): ActionPredicate;
  agent(input: AgentHandleInput): RelayAgentHandle;
  emitSessionEvent(agentId: string, event: AgentSessionEvent): void;
}

export class AgentRelay implements AgentRelayAgent {
  readonly messaging: RelayMessaging;
  private readonly actions: AgentRelayActions;
  readonly workspaceKey?: string;

  private readonly messagingOptions: RelaycastMessagingOptions;
  private readonly clientsByToken = new Map<string, RelayMessaging>();
  private readonly createAgentMessaging: (token: string) => RelayMessaging;
  private readonly eventFanIn: RelayEventFanIn;
  private enrichedMessages?: EnrichedMessages;
  private workspaceFacade?: RelayWorkspace;
  private hub?: ListenerHub;
  private readonly errorHooks = new Set<RelayErrorHook>();

  constructor(options: AgentRelayOptions = {}) {
    const { messaging, actions, workspaceKey, createAgentMessaging, onError, ...messagingOptions } = options;
    const resolvedWorkspaceKey = workspaceKey ?? messagingOptions.apiKey;
    this.workspaceKey = resolvedWorkspaceKey;
    this.messagingOptions = { ...messagingOptions, workspaceKey: resolvedWorkspaceKey };
    this.messaging = messaging ?? new RelaycastMessagingClient(this.messagingOptions);
    this.actions = actions ?? new ActionRegistry();
    this.createAgentMessaging =
      createAgentMessaging ??
      ((token) => new RelaycastMessagingClient({ ...this.messagingOptions, agentToken: token }));
    // Relaycast v5 streams events over each agent's node transport; the
    // workspace-key stream cannot receive them. The fan-in makes
    // `relay.addListener(...)` stream through every registered agent client
    // (added in `messagingForToken`), keeping the workspace client only as a
    // pre-registration fallback.
    this.eventFanIn = createEventFanIn(this.messaging.events, {
      onError: (error) => this.reportError(error, { source: 'listener', selector: 'events.connect' }),
    });
    if (onError) {
      this.errorHooks.add(onError);
    }
  }

  static async createWorkspace(input: string | AgentRelayCreateWorkspaceInput): Promise<AgentRelay> {
    const options = typeof input === 'string' ? { name: input } : input;
    const telemetry = relaycastTelemetryOptions(options);
    const workspace = (await RelayCast.createWorkspace(options.name, {
      baseUrl: options.baseUrl,
      ...relaycastWorkspaceTelemetryOptions(options),
    })) as Record<string, unknown>;
    const workspaceKey = extractWorkspaceKey(workspace);

    if (!workspaceKey) {
      throw new RelayError(
        'transport_error',
        'Workspace created, but the response did not include a workspace key.',
        { retryable: false }
      );
    }

    return new AgentRelay({
      workspaceKey,
      baseUrl: options.baseUrl,
      retryPolicy: options.retryPolicy,
      actions: options.actions,
      ...telemetry,
    });
  }

  get agents(): RelayMessaging['agents'] {
    return this.messaging.agents;
  }

  get channels(): RelayMessaging['channels'] {
    return this.messaging.channels;
  }

  get messages(): EnrichedMessages {
    if (!this.enrichedMessages) {
      this.enrichedMessages = createEnrichedMessages(this.messaging.messages, this.createMessagingResolver());
    }
    return this.enrichedMessages;
  }

  get threads(): RelayMessaging['threads'] {
    return this.messaging.threads;
  }

  get inbox(): RelayMessaging['inbox'] {
    return this.messaging.inbox;
  }

  get events(): EnrichedEvents {
    return this.listenerHub.events;
  }

  private get listenerHub(): ListenerHub {
    if (!this.hub) {
      this.hub = createListenerHub(this.eventFanIn, this.actions, {
        onError: (error, context) => this.reportError(error, context),
      });
    }
    return this.hub;
  }

  get deliveries(): RelayMessaging['deliveries'] {
    return this.messaging.deliveries;
  }

  get integrations(): RelayMessaging['integrations'] {
    return this.messaging.integrations;
  }

  get webhooks(): RelayMessaging['webhooks'] {
    return this.messaging.webhooks;
  }

  get capabilities(): RelayMessaging['commands'] {
    return this.messaging.commands;
  }

  get nodes(): RelayMessaging['nodes'] {
    return this.messaging.nodes;
  }

  get triggers(): RelayMessaging['triggers'] {
    return this.messaging.triggers;
  }

  get workspace(): RelayWorkspace {
    if (!this.workspaceFacade) {
      this.workspaceFacade = createWorkspaceFacade(this.messaging, {
        buildAgentClient: (registration) => this.buildAgentClient(registration),
        reconnectAgent: (apiToken) => this.reconnectAgent(apiToken),
      });
    }
    return this.workspaceFacade;
  }

  /** Build a live client bound to a freshly-registered agent. */
  private buildAgentClient(registration: RelayAgentRegistration): RelayAgentClient {
    return assembleAgentClient(
      this.messagingForToken(registration.token),
      this.actions,
      {
        id: registration.id,
        name: registration.name,
        token: registration.token,
      },
      { onError: (error, context) => this.reportError(error, context) }
    );
  }

  /** Rehydrate a live client from a persisted agent token, resolving identity from the relay. */
  private async reconnectAgent(apiToken: string): Promise<RelayAgentClient> {
    const messaging = this.messagingForToken(apiToken);
    const identity = await messaging.agents.me();
    return assembleAgentClient(
      messaging,
      this.actions,
      {
        id: identity.id,
        name: identity.name,
        token: apiToken,
      },
      { onError: (error, context) => this.reportError(error, context) }
    );
  }

  registerAction<TInput, TOutput>(
    def: RegisterActionInput<TInput, TOutput>
  ): TypedActionHandle<TInput, TOutput> {
    // The workspace-scoped client has no single handler-agent identity or
    // agent connection, so relay wiring is skipped and the action stays
    // in-process. Use an agent client (workspace.register / reconnect) to
    // register a relay-routed action.
    return registerFacadeAction(this.actions, def, {
      messaging: this.messaging,
      onError: (error, context) => this.reportError(error, context),
    });
  }

  /** Subscribe with a typed predicate — the handler receives the predicate's event type. */
  addListener<TEvent>(selector: ListenerPredicate<TEvent>, handler: ListenerHandler<TEvent>): () => void;
  /** Subscribe by dotted event name, `'*'`/prefix wildcard, or a predicate. */
  addListener<K extends keyof RelayEventMap>(
    selector: K,
    handler: ListenerHandler<RelayEventMap[K]>
  ): () => void;
  addListener(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void;
  addListener(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void {
    return this.listenerHub.addListener(selector, handler);
  }

  /** Like `addListener`, but auto-unsubscribes after the first matching event. */
  once<K extends keyof RelayEventMap>(selector: K, handler: ListenerHandler<RelayEventMap[K]>): () => void;
  once(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void;
  once(selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>): () => void {
    return this.listenerHub.once(selector, handler);
  }

  /**
   * Register a hook that receives listener and action handler errors. Returns
   * an unsubscribe callback. When no hook is registered, errors are logged as
   * console warnings.
   */
  onError(hook: RelayErrorHook): () => void {
    this.errorHooks.add(hook);
    return () => {
      this.errorHooks.delete(hook);
    };
  }

  private reportError(error: unknown, context: RelayErrorContext): void {
    if (this.errorHooks.size === 0) {
      logRelayHandlerError(error, context);
      return;
    }
    for (const hook of this.errorHooks) {
      try {
        hook(error, context);
      } catch {
        // Error hooks must not throw into the event source.
      }
    }
  }

  action(name: string): ActionPredicate {
    return this.listenerHub.action(name);
  }

  agent(input: AgentHandleInput): RelayAgentHandle {
    return this.listenerHub.agent(input);
  }

  emitSessionEvent(agentId: string, event: AgentSessionEvent): void {
    this.listenerHub.emitSessionEvent(agentId, event);
  }

  private messagingForToken(token: string): RelayMessaging {
    let client = this.clientsByToken.get(token);
    if (!client) {
      client = this.createAgentMessaging(token);
      this.clientsByToken.set(token, client);
      // Every registered agent's connection feeds the workspace-level
      // listener hub; the fan-in connects it lazily once a listener exists.
      this.eventFanIn.addSource(client.events);
    }
    return client;
  }

  private createMessagingResolver(): MessagingResolver {
    return (from) => {
      const token = resolveAgentToken(from);
      return token ? this.messagingForToken(token).messages : this.messaging.messages;
    };
  }
}

function extractWorkspaceKey(payload: Record<string, unknown>): string | undefined {
  const data =
    payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
  const value =
    payload.workspaceKey ??
    payload.workspace_key ??
    payload.apiKey ??
    payload.api_key ??
    data.workspaceKey ??
    data.workspace_key ??
    data.apiKey ??
    data.api_key;

  return typeof value === 'string' && value.trim() ? value : undefined;
}

export interface AgentRelayAgentOptions {
  /** Receives listener and action handler errors; defaults to console warnings. */
  onError?: RelayErrorHook;
}

export function agentRelayAgent(
  messaging: RelayMessaging,
  actions: AgentRelayActions,
  handlerAgent?: string,
  options?: AgentRelayAgentOptions
): AgentRelayAgent {
  // An acting-as agent client sends through its own token; `from` overrides are
  // best-effort and fall back to this client.
  const messages = createEnrichedMessages(messaging.messages, () => messaging.messages);
  const hub = createListenerHub(messaging.events, actions, { onError: options?.onError });
  return {
    messaging,
    agents: messaging.agents,
    channels: messaging.channels,
    messages,
    threads: messaging.threads,
    inbox: messaging.inbox,
    events: hub.events,
    deliveries: messaging.deliveries,
    integrations: messaging.integrations,
    webhooks: messaging.webhooks,
    capabilities: messaging.commands,
    nodes: messaging.nodes,
    triggers: messaging.triggers,
    workspace: createWorkspaceFacade(messaging),
    registerAction: (def) =>
      registerFacadeAction(actions, def, { messaging, handlerAgent, onError: options?.onError }),
    addListener: ((selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>) =>
      hub.addListener(selector, handler)) as AgentRelayAgent['addListener'],
    once: ((selector: string | ListenerPredicate, handler: ListenerHandler<RelayEvent>) =>
      hub.once(selector, handler)) as AgentRelayAgent['once'],
    action: (name) => hub.action(name),
    agent: (input) => hub.agent(input),
    emitSessionEvent: (agentId, event) => hub.emitSessionEvent(agentId, event),
  };
}

/**
 * Assemble a live agent client: an agent-scoped messaging surface plus the
 * agent's identity and status/tool predicate builders, with `reply`/`react`
 * convenience keyed on `messageId`.
 */
export function assembleAgentClient(
  messaging: RelayMessaging,
  actions: AgentRelayActions,
  identity: { id: string; name: string; handle?: string; token: string },
  options?: AgentRelayAgentOptions
): RelayAgentClient {
  const base = agentRelayAgent(messaging, actions, identity.name, options);
  const handle = createAgentHandle(identity);
  return {
    ...base,
    ...handle,
    sendMessage: (input) => base.messages.send(input),
    reply: (input) => base.messages.reply(input),
    react: (input) => base.messages.react(input.messageId, input.emoji),
  };
}
