import { Relay } from '../core.js';
import { formatRelayMessage, type Message, type MessageCallback } from '../types.js';

const DEFAULT_RELAY_SYSTEM_INSTRUCTIONS = [
  'You are connected to Agent Relay.',
  'Use relay_send for direct messages, relay_post for channel updates, relay_agents to inspect who is online, and relay_inbox to fetch buffered messages.',
  'When relay messages are injected below, treat them as the latest coordination context and respond or delegate as needed.',
].join(' ');

type JsonObjectSchema = {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: boolean;
};

export type AiSdkToolLike = {
  description?: string;
  inputSchema: JsonObjectSchema;
  execute?: (input: Record<string, string>) => Promise<unknown>;
};

export type AiSdkTools = Record<string, AiSdkToolLike>;

export type AiSdkMessageLike = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

export type AiSdkCallParams = {
  system?: string;
  messages?: AiSdkMessageLike[];
  prompt?: string;
  [key: string]: unknown;
};

export type AiSdkMiddlewareLike = {
  transformParams?: (input: { params: AiSdkCallParams }) => Promise<AiSdkCallParams> | AiSdkCallParams;
};

export type RelayLike = {
  send(to: string, text: string): Promise<void>;
  post(channel: string, text: string): Promise<void>;
  inbox(): Promise<Message[]>;
  agents(): Promise<string[]>;
  onMessage(callback: MessageCallback): () => void;
};

export interface AiSdkRelayOptions {
  /** Agent name used when registering with Relaycast. */
  name: string;
  /** Optional custom instructions appended to the system prompt on every model call. */
  instructions?: string;
  /** Disable the default relay instructions if you want to provide your own. */
  includeDefaultInstructions?: boolean;
}

export interface AiSdkRelaySession {
  /** AI SDK-compatible tool map for generateText/streamText. */
  tools: AiSdkTools;
  /** AI SDK language model middleware that injects pending relay messages into system. */
  middleware: AiSdkMiddlewareLike;
  /** Underlying relay client. */
  relay: RelayLike;
  /** Stop live routing and clear any injected-message state. */
  cleanup: () => void;
}

function schema(props: Record<string, Record<string, unknown>>, required: string[]): JsonObjectSchema {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

function createRelayTools(relay: RelayLike): AiSdkTools {
  return {
    relay_send: {
      description: 'Send a direct message to another relay agent.',
      inputSchema: schema({ to: { type: 'string' }, text: { type: 'string' } }, ['to', 'text']),
      async execute(input) {
        await relay.send(input.to, input.text);
        return { ok: true, status: `Sent relay message to ${input.to}.` };
      },
    },
    relay_inbox: {
      description: 'Drain and inspect newly received relay messages.',
      inputSchema: schema({}, []),
      async execute() {
        const messages = await relay.inbox();
        return {
          ok: true,
          messages,
          text: messages.length === 0 ? 'No new relay messages.' : messages.map(formatRelayMessage).join('\n'),
        };
      },
    },
    relay_post: {
      description: 'Post a message to a relay channel.',
      inputSchema: schema({ channel: { type: 'string' }, text: { type: 'string' } }, ['channel', 'text']),
      async execute(input) {
        await relay.post(input.channel, input.text);
        return { ok: true, status: `Posted relay message to #${input.channel}.` };
      },
    },
    relay_agents: {
      description: 'List currently online relay agents.',
      inputSchema: schema({}, []),
      async execute() {
        const agents = await relay.agents();
        return { ok: true, agents, text: agents.join('\n') };
      },
    },
  };
}

function composeRelayInstructions(pendingMessages: string[], options: AiSdkRelayOptions): string {
  const sections = [
    options.includeDefaultInstructions === false ? '' : DEFAULT_RELAY_SYSTEM_INSTRUCTIONS,
    options.instructions?.trim() ?? '',
    pendingMessages.length > 0 ? `--- Relay Messages ---\n${pendingMessages.join('\n')}` : '',
  ].filter((value) => value.length > 0);

  return sections.join('\n\n');
}

function composeSystemPrompt(baseSystem: string | undefined, pendingMessages: string[], options: AiSdkRelayOptions): string {
  const sections: string[] = [];

  if (baseSystem && baseSystem.trim().length > 0) {
    sections.push(baseSystem.trim());
  }

  const relayInstructions = composeRelayInstructions(pendingMessages, options);
  if (relayInstructions.length > 0) {
    sections.push(relayInstructions);
  }

  return sections.join('\n\n');
}

function injectSyntheticSystemMessage(
  messages: AiSdkMessageLike[] | undefined,
  pendingMessages: string[],
  options: AiSdkRelayOptions,
): AiSdkMessageLike[] | undefined {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const relayInstructions = composeRelayInstructions(pendingMessages, options);
  if (relayInstructions.length === 0) {
    return messages;
  }

  return [{ role: 'system', content: relayInstructions }, ...messages];
}

/**
 * Create AI SDK tools + middleware for putting a model-driven app on Agent Relay.
 *
 * Typical usage pairs the returned `middleware` with `wrapLanguageModel(...)`
 * from `ai`, and the returned `tools` with `generateText(...)` or `streamText(...)`.
 */
export function onRelay(
  options: AiSdkRelayOptions,
  relay: RelayLike = new Relay(options.name),
): AiSdkRelaySession {
  const tools = createRelayTools(relay);
  const pendingMessages: string[] = [];

  const unsubscribe = relay.onMessage(async (message) => {
    pendingMessages.push(formatRelayMessage(message));
  });

  return {
    tools,
    relay,
    middleware: {
      async transformParams({ params }): Promise<AiSdkCallParams> {
        const liveMessages = pendingMessages.splice(0, pendingMessages.length);
        const hasMessages = Array.isArray(params.messages);
        const baseSystem = typeof params.system === 'string' ? params.system : undefined;
        const nextMessages = injectSyntheticSystemMessage(
          hasMessages ? [...(params.messages ?? [])] : params.messages,
          liveMessages,
          options,
        );

        return {
          ...params,
          messages: nextMessages,
          system: hasMessages ? baseSystem : composeSystemPrompt(baseSystem, liveMessages, options),
        };
      },
    },
    cleanup() {
      unsubscribe();
      pendingMessages.splice(0, pendingMessages.length);
    },
  };
}
