import { Relay } from '../core.js';
import { formatRelayInbox, formatRelayMessage, type Message, type MessageCallback } from '../types.js';

type JsonObjectSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
};

type FunctionToolLike = {
  name: string;
  description: string;
};

type ToolUnionLike = FunctionToolLike;

type RunnerLike = {
  runAsync(params: {
    userId: string;
    sessionId: string;
    newMessage: { role: string; parts: Array<{ text: string }> };
  }): AsyncGenerator<unknown, void, undefined>;
};

type LlmAgentLike = {
  name: string;
  tools: ToolUnionLike[];
};

type RelayLike = {
  send(to: string, text: string): Promise<void>;
  post(channel: string, text: string): Promise<void>;
  inbox(): Promise<Message[]>;
  agents(): Promise<string[]>;
  onMessage(callback: MessageCallback): () => void;
};

interface GoogleAdkRelayOptions {
  /** Google ADK LlmAgent instance. */
  agent: LlmAgentLike;
  /** Optional Runner for routing incoming messages to the agent. */
  runner?: RunnerLike;
  /** User ID for runner sessions. Defaults to 'relay'. */
  userId?: string;
  /** Session ID for runner sessions. Defaults to 'relay-session'. */
  sessionId?: string;
}

/**
 * Create a FunctionTool-shaped object for Google ADK.
 * We construct the tool objects duck-typed to avoid importing the actual
 * FunctionTool class (which requires @google/genai at runtime).
 */
function createRelayFunctionTools(relay: RelayLike): FunctionToolLike[] {
  // We dynamically import FunctionTool to create real ADK tool instances
  // For now, we build tool-like objects that match the FunctionTool constructor shape
  // and lazily construct them.
  const toolDefs: Array<{
    name: string;
    description: string;
    parameters: JsonObjectSchema;
    execute: (input: Record<string, string>) => Promise<Record<string, unknown>>;
  }> = [
    {
      name: 'relay_send',
      description: 'Send a direct message to another relay agent.',
      parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] },
      async execute(input) {
        await relay.send(input.to, input.text);
        return { result: `Sent relay message to ${input.to}.` };
      },
    },
    {
      name: 'relay_inbox',
      description: 'Drain and inspect newly received relay messages.',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        return { result: formatRelayInbox(await relay.inbox()) };
      },
    },
    {
      name: 'relay_post',
      description: 'Post a message to a relay channel.',
      parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] },
      async execute(input) {
        await relay.post(input.channel, input.text);
        return { result: `Posted relay message to #${input.channel}.` };
      },
    },
    {
      name: 'relay_agents',
      description: 'List currently online relay agents.',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        return { result: (await relay.agents()).join('\n') };
      },
    },
  ];

  return toolDefs;
}

/**
 * Attach relay communication tools and message routing to a Google ADK agent.
 * @param name - Agent name for relay registration.
 * @param options - Google ADK agent and optional runner configuration.
 * @param relay - Optional pre-configured Relay instance.
 * @returns Object with the augmented agent, an unsubscribe function, and the relay tools added.
 */
export function onRelay(
  name: string,
  options: GoogleAdkRelayOptions,
  relay: RelayLike = new Relay(name),
): { agent: LlmAgentLike; tools: FunctionToolLike[]; unsubscribe: () => void } {
  const { agent, runner, userId = 'relay', sessionId = 'relay-session' } = options;

  const relayTools = createRelayFunctionTools(relay);

  // Append relay tools to the agent's tool list
  for (const tool of relayTools) {
    agent.tools.push(tool as ToolUnionLike);
  }

  let unsubscribe: () => void = () => {};

  if (runner) {
    unsubscribe = relay.onMessage(async (message: Message) => {
      const prompt = formatRelayMessage(message);
      const content = { role: 'user', parts: [{ text: prompt }] };

      // Drain the async generator to completion
      for await (const _event of runner.runAsync({ userId, sessionId, newMessage: content })) {
        // Events are consumed; the agent handles them internally.
      }
    });
  }

  return { agent, tools: relayTools, unsubscribe };
}
