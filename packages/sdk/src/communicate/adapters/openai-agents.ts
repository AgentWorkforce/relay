import { Relay } from '../core.js';
import { formatRelayInbox, formatRelayMessage, type Message, type MessageCallback } from '../types.js';

type RelayLike = {
  send(to: string, text: string): Promise<void>;
  post(channel: string, text: string): Promise<void>;
  inbox(): Promise<Message[]>;
  agents(): Promise<string[]>;
  onMessage(callback: MessageCallback): () => void;
};

type JsonObjectSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: boolean;
};

type FunctionToolLike = {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonObjectSchema;
  strict: boolean;
  invoke: (runContext: unknown, input: string) => Promise<string>;
  needsApproval: false;
  isEnabled: true;
};

type AgentLike = {
  name: string;
  instructions: string | ((...args: unknown[]) => string | Promise<string>);
  tools: unknown[];
};

function schema(props: Record<string, Record<string, unknown>>, required: string[]): JsonObjectSchema {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

function createRelayTools(relay: RelayLike): FunctionToolLike[] {
  const defs: Array<[string, string, JsonObjectSchema, (p: Record<string, string>) => Promise<string>]> = [
    ['relay_send', 'Send a direct message to another relay agent.',
      schema({ to: { type: 'string' }, text: { type: 'string' } }, ['to', 'text']),
      async (p) => { await relay.send(p.to, p.text); return `Sent relay message to ${p.to}.`; }],
    ['relay_inbox', 'Drain and inspect newly received relay messages.',
      schema({}, []),
      async () => formatRelayInbox(await relay.inbox())],
    ['relay_post', 'Post a message to a relay channel.',
      schema({ channel: { type: 'string' }, text: { type: 'string' } }, ['channel', 'text']),
      async (p) => { await relay.post(p.channel, p.text); return `Posted relay message to #${p.channel}.`; }],
    ['relay_agents', 'List currently online relay agents.',
      schema({}, []),
      async () => (await relay.agents()).join('\n')],
  ];

  return defs.map(([name, description, parameters, run]) => ({
    type: 'function' as const,
    name,
    description,
    parameters,
    strict: false,
    needsApproval: false as const,
    isEnabled: true as const,
    async invoke(_runContext: unknown, input: string): Promise<string> {
      const params = input ? JSON.parse(input) : {};
      return run(params);
    },
  }));
}

/**
 * Attach relay communication tools and message routing to an OpenAI Agent.
 * @param agent - OpenAI Agent instance to augment with relay tools.
 * @param relay - Optional pre-configured Relay instance.
 * @returns Object with the augmented agent and a cleanup function.
 */
export function onRelay<TAgent extends AgentLike>(
  agent: TAgent,
  relay: RelayLike = new Relay(agent.name),
): { agent: TAgent; cleanup: () => void } {
  const relayTools = createRelayTools(relay);
  agent.tools = [...agent.tools, ...relayTools];

  const pendingMessages: string[] = [];
  const originalInstructions = agent.instructions;

  const unsubscribe = relay.onMessage(async (message) => {
    pendingMessages.push(formatRelayMessage(message));
  });

  agent.instructions = async (...args: unknown[]): Promise<string> => {
    let base: string;
    if (typeof originalInstructions === 'function') {
      base = await originalInstructions(...args);
    } else {
      base = originalInstructions ?? '';
    }

    if (pendingMessages.length > 0) {
      const msgs = pendingMessages.splice(0, pendingMessages.length);
      return `${base}\n\n--- Relay Messages ---\n${msgs.join('\n')}`;
    }
    return base;
  };

  const cleanup = (): void => {
    unsubscribe();
    agent.instructions = originalInstructions;
    agent.tools = agent.tools.filter((t) => !relayTools.includes(t as FunctionToolLike));
  };

  return { agent, cleanup };
}
