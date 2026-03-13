import { Type } from '@sinclair/typebox';

import { Relay } from '../core.js';
import { formatRelayInbox, formatRelayMessage, type Message, type MessageCallback } from '../types.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
};

type RelayTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: unknown
  ) => Promise<ToolResult>;
};

type PiSessionLike = {
  isStreaming: boolean;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
};

type PiConfigLike = {
  customTools?: RelayTool[];
  onSessionCreated?: (session: PiSessionLike) => void | Promise<void>;
};

type RelayLike = {
  send(to: string, text: string): Promise<void>;
  post(channel: string, text: string): Promise<void>;
  inbox(): Promise<Message[]>;
  agents(): Promise<string[]>;
  onMessage(callback: MessageCallback): () => void;
};

function textToolResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    details: {},
  };
}

function createRelayTools(relay: RelayLike): RelayTool[] {
  return [
    {
      name: 'relay_send',
      label: 'Relay send',
      description: 'Send a direct message to another relay agent.',
      parameters: Type.Object({
        to: Type.String(),
        text: Type.String(),
      }),
      async execute(_toolCallId, params: { to: string; text: string }) {
        await relay.send(params.to, params.text);
        return textToolResult(`Sent relay message to ${params.to}.`);
      },
    },
    {
      name: 'relay_inbox',
      label: 'Relay inbox',
      description: 'Drain and inspect newly received relay messages.',
      parameters: Type.Object({}),
      async execute() {
        const messages = await relay.inbox();
        return textToolResult(formatRelayInbox(messages));
      },
    },
    {
      name: 'relay_post',
      label: 'Relay post',
      description: 'Post a message to a relay channel.',
      parameters: Type.Object({
        channel: Type.String(),
        text: Type.String(),
      }),
      async execute(_toolCallId, params: { channel: string; text: string }) {
        await relay.post(params.channel, params.text);
        return textToolResult(`Posted relay message to #${params.channel}.`);
      },
    },
    {
      name: 'relay_agents',
      label: 'Relay agents',
      description: 'List currently online relay agents.',
      parameters: Type.Object({}),
      async execute() {
        const agents = await relay.agents();
        return textToolResult(agents.join('\n'));
      },
    },
  ];
}

export function onRelay<TConfig extends PiConfigLike>(
  name: string,
  config: TConfig,
  relay: RelayLike = new Relay(name)
): TConfig & { customTools: RelayTool[]; onSessionCreated: (session: PiSessionLike) => Promise<void> } {
  const customTools = [...(config.customTools ?? []), ...createRelayTools(relay)];
  const originalOnSessionCreated = config.onSessionCreated;
  let unsubscribe: (() => void) | undefined;

  return {
    ...config,
    customTools,
    async onSessionCreated(session: PiSessionLike): Promise<void> {
      if (originalOnSessionCreated) {
        await originalOnSessionCreated(session);
      }

      unsubscribe?.();
      unsubscribe = relay.onMessage(async (message) => {
        const prompt = formatRelayMessage(message);
        if (session.isStreaming) {
          await session.steer(prompt);
          return;
        }
        await session.followUp(prompt);
      });
    },
  };
}
