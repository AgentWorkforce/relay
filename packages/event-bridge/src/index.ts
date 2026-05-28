/**
 * `@agent-relay/event-bridge` — connect a long-lived on-relay agent to inbound
 * integration webhook events.
 *
 * Inbound: subscribes to the relay gateway for provider file changes (Slack
 * first; Linear/Notion follow the same {@link ProviderAdapter} contract) and
 * injects a nudge into the target broker agent. Outbound: watches the agent's
 * outbox directory and relays each reply file through the gateway as a
 * relayfile write, which the provider writeback posts back to the source.
 */
export { createEventBridge } from './bridge.js';
export type { BrokerLike, BridgeLogger, EventBridgeDeps, EventBridgeHandle } from './bridge.js';

export { resolveConfigFromEnv } from './config.js';
export type { EventBridgeConfig } from './config.js';

export { bootstrapGatewayAccess } from './bootstrap.js';
export type { BootstrapOptions, GatewayAccess } from './bootstrap.js';

export { startOutboxWatcher } from './outbox.js';
export type { OutboxWatcherHandle, OutboxWatcherOptions } from './outbox.js';

export { createProvider, slackProvider, KNOWN_PROVIDERS } from './providers/index.js';
export type { KnownProviderName, SlackProviderOptions } from './providers/index.js';

export type { InboundContext, InboundItem, ProviderAdapter, WorkspaceFileLike } from './types.js';
