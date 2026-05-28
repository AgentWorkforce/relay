import { RelayCast } from '@relaycast/sdk';

import { ActionRegistry, type AgentRelayActions } from './actions/index.js';
import {
  RelaycastMessagingClient,
  type RelayAgentRegistration,
  type RelayMessaging,
  type RelaycastMessagingOptions,
} from './messaging/index.js';

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
  readonly messages: RelayMessaging['messages'];
  readonly threads: RelayMessaging['threads'];
  readonly inbox: RelayMessaging['inbox'];
  readonly events: RelayMessaging['events'];
  readonly deliveries: RelayMessaging['deliveries'];
}

export class AgentRelay implements AgentRelayAgent {
  readonly messaging: RelayMessaging;
  readonly actions: AgentRelayActions;
  readonly workspaceKey?: string;

  private readonly messagingOptions: RelaycastMessagingOptions;

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

  get messages(): RelayMessaging['messages'] {
    return this.messaging.messages;
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
  return {
    messaging,
    actions,
    agents: messaging.agents,
    channels: messaging.channels,
    messages: messaging.messages,
    threads: messaging.threads,
    inbox: messaging.inbox,
    events: messaging.events,
    deliveries: messaging.deliveries,
  };
}
