import { RelayCast } from '@relaycast/sdk';

import { ActionRegistry, type AgentRelayActions, type ActionHandle } from './actions/index.js';
import {
  RelaycastMessagingClient,
  type RelayAgentRegistration,
  type RelayMessage,
  type RelayMessaging,
  type RelaycastMessagingOptions,
} from './messaging/index.js';
import {
  createEnrichedMessages,
  createNotifyHandler,
  createWorkspaceFacade,
  registerFacadeAction,
  resolveAgentToken,
  type AgentLike,
  type EnrichedMessages,
  type MessagingResolver,
  type NotifyHandler,
  type NotifyOptions,
  type RegisterActionInput,
  type RelaySendMessageInput,
  type RelayWorkspace,
} from './facade.js';

export interface AgentRelayOptions extends RelaycastMessagingOptions {
  messaging?: RelayMessaging;
  actions?: AgentRelayActions;
}

export interface AgentRelayCreateWorkspaceInput {
  name: string;
  baseUrl?: string;
  retryPolicy?: RelaycastMessagingOptions['retryPolicy'];
  actions?: AgentRelayActions;
}

export interface AgentRelayAgent {
  readonly messaging: RelayMessaging;
  readonly actions: AgentRelayActions;
  readonly agents: RelayMessaging['agents'];
  readonly channels: RelayMessaging['channels'];
  readonly messages: EnrichedMessages;
  readonly threads: RelayMessaging['threads'];
  readonly inbox: RelayMessaging['inbox'];
  readonly events: RelayMessaging['events'];
  readonly deliveries: RelayMessaging['deliveries'];
  readonly workspace: RelayWorkspace;
  sendMessage(input: RelaySendMessageInput): Promise<RelayMessage>;
  registerAction<TInput, TOutput>(def: RegisterActionInput<TInput, TOutput>): ActionHandle;
  notify(target: AgentLike, options: NotifyOptions): NotifyHandler;
}

export class AgentRelay implements AgentRelayAgent {
  readonly messaging: RelayMessaging;
  readonly actions: AgentRelayActions;
  readonly workspaceKey?: string;

  private readonly messagingOptions: RelaycastMessagingOptions;
  private readonly clientsByToken = new Map<string, RelayMessaging>();
  private enrichedMessages?: EnrichedMessages;
  private workspaceFacade?: RelayWorkspace;

  constructor(options: AgentRelayOptions = {}) {
    const { messaging, actions, workspaceKey, ...messagingOptions } = options;
    const resolvedWorkspaceKey = workspaceKey ?? messagingOptions.apiKey;
    this.workspaceKey = resolvedWorkspaceKey;
    this.messagingOptions = { ...messagingOptions, workspaceKey: resolvedWorkspaceKey };
    this.messaging = messaging ?? new RelaycastMessagingClient(this.messagingOptions);
    this.actions = actions ?? new ActionRegistry();
  }

  static async createWorkspace(input: string | AgentRelayCreateWorkspaceInput): Promise<AgentRelay> {
    const options = typeof input === 'string' ? { name: input } : input;
    const workspace = (await RelayCast.createWorkspace(options.name, {
      baseUrl: options.baseUrl,
    })) as Record<string, unknown>;
    const workspaceKey = extractWorkspaceKey(workspace);

    if (!workspaceKey) {
      throw new Error('Workspace created, but the response did not include a workspace key.');
    }

    return new AgentRelay({
      workspaceKey,
      baseUrl: options.baseUrl,
      retryPolicy: options.retryPolicy,
      actions: options.actions,
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
      this.enrichedMessages = createEnrichedMessages(
        this.messaging.messages,
        this.createMessagingResolver()
      );
    }
    return this.enrichedMessages;
  }

  get threads(): RelayMessaging['threads'] {
    return this.messaging.threads;
  }

  get inbox(): RelayMessaging['inbox'] {
    return this.messaging.inbox;
  }

  get events(): RelayMessaging['events'] {
    return this.messaging.events;
  }

  get deliveries(): RelayMessaging['deliveries'] {
    return this.messaging.deliveries;
  }

  get workspace(): RelayWorkspace {
    if (!this.workspaceFacade) {
      this.workspaceFacade = createWorkspaceFacade(this.messaging);
    }
    return this.workspaceFacade;
  }

  /** High-level send. `to` may be a `#channel` or an agent name/handle. */
  sendMessage(input: RelaySendMessageInput): Promise<RelayMessage> {
    return this.messages.send(input);
  }

  registerAction<TInput, TOutput>(def: RegisterActionInput<TInput, TOutput>): ActionHandle {
    return registerFacadeAction(this.actions, def);
  }

  notify(target: AgentLike, options: NotifyOptions): NotifyHandler {
    return createNotifyHandler(this.messages, target, options);
  }

  as(agent: RelayAgentRegistration | { token: string } | string): AgentRelayAgent {
    const token = typeof agent === 'string' ? agent : agent.token;
    return agentRelayAgent(
      new RelaycastMessagingClient({ ...this.messagingOptions, agentToken: token }),
      this.actions
    );
  }

  asAgent(agentToken: string): AgentRelayAgent {
    return this.as(agentToken);
  }

  private messagingForToken(token: string): RelayMessaging {
    let client = this.clientsByToken.get(token);
    if (!client) {
      client = new RelaycastMessagingClient({ ...this.messagingOptions, agentToken: token });
      this.clientsByToken.set(token, client);
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

export function agentRelayAgent(messaging: RelayMessaging, actions: AgentRelayActions): AgentRelayAgent {
  // An acting-as agent client sends through its own token; `from` overrides are
  // best-effort and fall back to this client.
  const messages = createEnrichedMessages(messaging.messages, () => messaging.messages);
  return {
    messaging,
    actions,
    agents: messaging.agents,
    channels: messaging.channels,
    messages,
    threads: messaging.threads,
    inbox: messaging.inbox,
    events: messaging.events,
    deliveries: messaging.deliveries,
    workspace: createWorkspaceFacade(messaging),
    sendMessage: (input) => messages.send(input),
    registerAction: (def) => registerFacadeAction(actions, def),
    notify: (target, options) => createNotifyHandler(messages, target, options),
  };
}
