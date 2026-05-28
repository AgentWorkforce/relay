/**
 * Resolved configuration for an event bridge instance.
 */
export interface EventBridgeConfig {
  /** Relay workspace whose integration events are streamed. */
  workspace: string;
  /** Relay API key, used for both the gateway stream and broker (when remote). */
  apiKey: string;
  /** Name of the long-lived on-relay agent to inject inbound messages into. */
  agentName: string;
  /** Providers to route, e.g. `['slack']`. */
  providers: string[];
  /** Local directory the agent writes reply files into. */
  outboxDir: string;
  /** Override the gateway websocket URL (defaults to the SDK default). */
  gatewayUrl?: string;
  /** Remote broker base URL. When unset, the bridge connects to a local broker. */
  brokerUrl?: string;
  /** Working directory used to locate a local broker's `connection.json`. */
  brokerCwd?: string;
  /** Injection mode: `wait` queues until the agent is idle, `steer` interrupts. */
  injectMode: 'wait' | 'steer';
  /** Watch replay policy on start: `none`, `last:<n>`, or `since:<iso>`. */
  replayOnStart?: string;
}

const DEFAULT_OUTBOX = './outbox';

/**
 * Build an {@link EventBridgeConfig} from environment variables.
 *
 * Required: `RELAY_WORKSPACE` (or `RELAY_WORKSPACE_ID`), `RELAY_API_KEY`,
 * `EVENT_BRIDGE_AGENT`.
 */
export function resolveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EventBridgeConfig {
  const workspace = trim(env.RELAY_WORKSPACE) ?? trim(env.RELAY_WORKSPACE_ID);
  if (!workspace) {
    throw new Error('RELAY_WORKSPACE (or RELAY_WORKSPACE_ID) is required');
  }
  const apiKey = trim(env.RELAY_API_KEY);
  if (!apiKey) {
    throw new Error('RELAY_API_KEY is required');
  }
  const agentName = trim(env.EVENT_BRIDGE_AGENT);
  if (!agentName) {
    throw new Error('EVENT_BRIDGE_AGENT (target on-relay agent name) is required');
  }

  const providers = csv(env.EVENT_BRIDGE_PROVIDERS) ?? ['slack'];
  const injectMode = trim(env.EVENT_BRIDGE_INJECT_MODE) === 'steer' ? 'steer' : 'wait';

  return {
    workspace,
    apiKey,
    agentName,
    providers,
    outboxDir: trim(env.EVENT_BRIDGE_OUTBOX) ?? DEFAULT_OUTBOX,
    gatewayUrl: trim(env.RELAY_GATEWAY_URL),
    brokerUrl: trim(env.RELAY_BROKER_URL),
    brokerCwd: trim(env.RELAY_BROKER_CWD),
    injectMode,
    replayOnStart: trim(env.EVENT_BRIDGE_REPLAY),
  };
}

function trim(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function csv(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}
