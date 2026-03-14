import { Relay } from '../core.js';
import { formatRelayInbox, formatRelayMessage, type Message, type MessageCallback } from '../types.js';

/**
 * Minimal structural types mirroring the CrewAI JS SDK's Agent and Crew classes.
 * We use duck-typing so callers don't need to import crewai directly.
 */

type CrewAITool = {
  tool_name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

type CrewAIAgentLike = {
  role: string;
  tools: any[];
  step_callback?: ((step: any) => void) | null;
};

type CrewAICrewLike = {
  agents: CrewAIAgentLike[];
  task_callback?: ((output: any) => void) | null;
};

type RelayLike = {
  send(to: string, text: string): Promise<void>;
  post(channel: string, text: string): Promise<void>;
  inbox(): Promise<Message[]>;
  agents(): Promise<string[]>;
  onMessage(callback: MessageCallback): () => void;
};

function createRelayTools(relay: RelayLike): CrewAITool[] {
  return [
    {
      tool_name: 'relay_send',
      description: 'Send a direct message to another relay agent.',
      async execute(args) {
        await relay.send(args.to as string, args.text as string);
        return `Sent relay message to ${args.to}.`;
      },
    },
    {
      tool_name: 'relay_inbox',
      description: 'Drain and inspect newly received relay messages.',
      async execute() {
        return formatRelayInbox(await relay.inbox());
      },
    },
    {
      tool_name: 'relay_post',
      description: 'Post a message to a relay channel.',
      async execute(args) {
        await relay.post(args.channel as string, args.text as string);
        return `Posted relay message to #${args.channel}.`;
      },
    },
    {
      tool_name: 'relay_agents',
      description: 'List currently online relay agents.',
      async execute() {
        return (await relay.agents()).join('\n');
      },
    },
  ];
}

/**
 * Attach relay communication tools and message routing to a CrewAI Agent.
 *
 * Adds relay tools to the agent's `tools` array and installs a `step_callback`
 * that receives incoming relay messages.
 *
 * @param agent - A CrewAI Agent instance (or duck-typed equivalent).
 * @param relay - Optional pre-configured Relay instance.
 * @returns Object with an `unsubscribe` function to stop message routing.
 */
export function onRelay(
  agent: CrewAIAgentLike,
  relay?: RelayLike,
): { unsubscribe: () => void } {
  const relayInstance: RelayLike = relay ?? new Relay(agent.role);
  const relayTools = createRelayTools(relayInstance);

  // Append relay tools to agent's tools array
  for (const tool of relayTools) {
    agent.tools.push(tool);
  }

  // Install message routing via step_callback
  const originalCallback = agent.step_callback;

  const unsubscribe = relayInstance.onMessage(async (message) => {
    const formatted = formatRelayMessage(message);

    // If there's a step_callback, route through it
    if (agent.step_callback) {
      agent.step_callback({ relay_message: formatted });
    }
  });

  // Preserve original step_callback
  if (originalCallback) {
    agent.step_callback = (step: any) => {
      originalCallback(step);
    };
  }

  return { unsubscribe };
}

/**
 * Attach relay communication tools to all agents in a CrewAI Crew.
 *
 * @param crew - A CrewAI Crew instance (or duck-typed equivalent).
 * @param relay - Optional pre-configured Relay instance.
 * @returns Object with an `unsubscribe` function to stop all message routing.
 */
export function onCrewRelay(
  crew: CrewAICrewLike,
  relay?: RelayLike,
): { unsubscribe: () => void } {
  const unsubscribers: Array<() => void> = [];

  for (const agent of crew.agents) {
    const result = onRelay(agent, relay);
    unsubscribers.push(result.unsubscribe);
  }

  return {
    unsubscribe() {
      for (const unsub of unsubscribers) {
        unsub();
      }
    },
  };
}
