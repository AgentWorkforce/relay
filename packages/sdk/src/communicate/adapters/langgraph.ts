import { Relay } from '../core.js';
import { formatRelayInbox, formatRelayMessage, type Message, type MessageCallback } from '../types.js';

/** Minimal shape of a LangGraph CompiledStateGraph for relay integration. */
type CompiledGraphLike = {
  invoke(input: Record<string, unknown>, config?: Record<string, unknown>): Promise<Record<string, unknown>>;
  nodes: Record<string, unknown>;
};

type RelayLike = {
  send(to: string, text: string): Promise<void>;
  post(channel: string, text: string): Promise<void>;
  inbox(): Promise<Message[]>;
  agents(): Promise<string[]>;
  onMessage(callback: MessageCallback): () => void;
};

/** A tool definition compatible with LangGraph ToolNode. */
export interface RelayToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  invoke(input: Record<string, string>): Promise<string>;
}

function createRelayTools(relay: RelayLike): RelayToolDef[] {
  return [
    {
      name: 'relay_send',
      description: 'Send a direct message to another relay agent.',
      schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient agent name' },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['to', 'text'],
      },
      async invoke(input: Record<string, string>) {
        await relay.send(input.to, input.text);
        return `Sent relay message to ${input.to}.`;
      },
    },
    {
      name: 'relay_inbox',
      description: 'Drain and inspect newly received relay messages.',
      schema: { type: 'object', properties: {}, required: [] },
      async invoke() {
        return formatRelayInbox(await relay.inbox());
      },
    },
    {
      name: 'relay_post',
      description: 'Post a message to a relay channel.',
      schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel name' },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['channel', 'text'],
      },
      async invoke(input: Record<string, string>) {
        await relay.post(input.channel, input.text);
        return `Posted relay message to #${input.channel}.`;
      },
    },
    {
      name: 'relay_agents',
      description: 'List currently online relay agents.',
      schema: { type: 'object', properties: {}, required: [] },
      async invoke() {
        return (await relay.agents()).join('\n');
      },
    },
  ];
}

export interface LangGraphRelayResult {
  /** Relay tool definitions to pass to a LangGraph ToolNode. */
  tools: RelayToolDef[];
  /** Unsubscribe from incoming relay messages. */
  unsubscribe: () => void;
}

/**
 * Attach relay communication tools and message routing to a LangGraph compiled graph.
 *
 * Tools are returned as objects compatible with LangGraph's ToolNode. Incoming
 * relay messages are routed into the graph via `graph.invoke()` with a
 * `messages` state update.
 *
 * @param graph - A compiled LangGraph state graph.
 * @param relayOrName - Optional pre-configured Relay instance or agent name string (defaults to 'langgraph').
 * @returns Relay tools and an unsubscribe handle.
 */
export function onRelay(
  graph: CompiledGraphLike,
  relayOrName?: RelayLike | string,
): LangGraphRelayResult {
  const r: RelayLike = typeof relayOrName === 'string'
    ? new Relay(relayOrName) as unknown as RelayLike
    : relayOrName ?? (new Relay('langgraph') as unknown as RelayLike);
  const tools = createRelayTools(r);

  const unsubscribe = r.onMessage(async (message) => {
    const prompt = formatRelayMessage(message);
    await graph.invoke({ messages: [{ role: 'user', content: prompt }] });
  });

  return { tools, unsubscribe };
}
