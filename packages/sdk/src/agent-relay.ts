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

  private readonly messagingOptions: RelaycastMessagingOptions;

  constructor(options: AgentRelayOptions = {}) {
    const { messaging, actions, ...messagingOptions } = options;
    this.messagingOptions = messagingOptions;
    this.messaging = messaging ?? new RelaycastMessagingClient(messagingOptions);
    this.actions = actions ?? new ActionRegistry();
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
