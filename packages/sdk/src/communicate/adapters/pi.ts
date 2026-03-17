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

const txt = (text: string): ToolResult => ({ content: [{ type: 'text', text }], details: {} });

function createRelayTools(relay: RelayLike): RelayTool[] {
  const toolDefs: Array<[string, string, unknown, (p: Record<string, string>) => Promise<string>]> = [
    ['relay_send', 'Send a direct message to another relay agent.',
      Type.Object({ to: Type.String(), text: Type.String() }),
      async (p) => { await relay.send(p.to, p.text); return `Sent relay message to ${p.to}.`; }],
    ['relay_inbox', 'Drain and inspect newly received relay messages.',
      Type.Object({}),
      async () => formatRelayInbox(await relay.inbox())],
    ['relay_post', 'Post a message to a relay channel.',
      Type.Object({ channel: Type.String(), text: Type.String() }),
      async (p) => { await relay.post(p.channel, p.text); return `Posted relay message to #${p.channel}.`; }],
    ['relay_agents', 'List currently online relay agents.',
      Type.Object({}),
      async () => (await relay.agents()).join('\n')],
  ];
  return toolDefs.map(([name, description, parameters, run]) => ({
    name, label: name.replace('_', ' '), description, parameters,
    async execute(_id: string, params: Record<string, string>) { return txt(await run(params)); },
  }));
}

/**
 * Attach relay communication tools and message routing to a Pi agent config.
 * @param name - Agent name for relay registration.
 * @param config - Pi agent session config to augment.
 * @param relay - Optional pre-configured Relay instance.
 * @returns Augmented config with relay tools and session hook.
 */
export function onRelay<TConfig extends PiConfigLike>(
  name: string,
  config: TConfig,
  relay: RelayLike = new Relay(name)
): TConfig & { customTools: RelayTool[]; onSessionCreated: (session: PiSessionLike) => Promise<void>; cleanup: () => void } {
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
    cleanup() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
