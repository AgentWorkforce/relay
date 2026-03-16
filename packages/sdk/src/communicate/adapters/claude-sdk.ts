import { Relay } from '../core.js';
import { formatRelayMessage, type Message } from '../types.js';

type HookResult = {
  continue?: boolean;
  systemMessage?: string;
};

type HookCallback = (...args: unknown[]) => Promise<HookResult>;

type HookMatcher = {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
};

type ClaudeOptionsLike = {
  mcpServers?: Record<string, unknown>;
  hooks?: Partial<Record<'PostToolUse' | 'Stop', HookMatcher[]>>;
};

type RelayLike = {
  inbox(): Promise<Message[]>;
};

function appendHook(
  hooks: ClaudeOptionsLike['hooks'],
  event: 'PostToolUse' | 'Stop',
  callback: HookCallback
): ClaudeOptionsLike['hooks'] {
  const matchers = [...(hooks?.[event] ?? []), { hooks: [callback] }];

  return {
    ...hooks,
    [event]: matchers,
  };
}

async function drainInbox(relay: RelayLike): Promise<string | undefined> {
  const messages = await relay.inbox();
  if (messages.length === 0) {
    return undefined;
  }

  return `New messages from other agents:\n${messages.map((message) => formatRelayMessage(message)).join('\n')}`;
}

/**
 * Attach relay communication to Claude Agent SDK options via MCP server and hooks.
 * @param _name - Agent name for relay registration.
 * @param options - Claude SDK query options to augment.
 * @param relay - Optional pre-configured Relay instance.
 * @returns Augmented options with relaycast MCP server and inbox-draining hooks.
 */
export function onRelay<TOptions extends ClaudeOptionsLike>(
  _name: string,
  options: TOptions,
  relay: RelayLike = new Relay(_name)
): TOptions {
  const mcpServers = {
    ...(options.mcpServers ?? {}),
    relaycast: {
      command: 'agent-relay',
      args: ['mcp'],
    },
  };

  let hooks = options.hooks;

  hooks = appendHook(hooks, 'PostToolUse', async () => {
    const systemMessage = await drainInbox(relay);
    return systemMessage ? { systemMessage } : {};
  });

  hooks = appendHook(hooks, 'Stop', async () => {
    const systemMessage = await drainInbox(relay);
    return systemMessage ? { continue: true, systemMessage } : {};
  });

  return {
    ...options,
    mcpServers,
    hooks,
  };
}
