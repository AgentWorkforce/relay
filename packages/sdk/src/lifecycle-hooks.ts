/**
 * Typed lifecycle-hook surface for `AgentRelay` / `AgentRelayClient`.
 *
 * Two kinds of events flow through the same registry:
 *
 * 1. **Broker events** — `agentSpawned`, `agentReleased`, `agentExited`,
 *    `agentReady`, `agentIdle`, `agentExitRequested`,
 *    `agentActivityChanged`, `agentResult`, `messageReceived`,
 *    `messageSent`, `workerOutput`, `deliveryUpdate`, `channelSubscribed`,
 *    `channelUnsubscribed`. These fire when the broker emits the
 *    corresponding event over the WS stream.
 * 2. **Call-site hooks** — `beforeAgentSpawn`, `afterAgentSpawn`,
 *    `beforeAgentRelease`, `afterAgentRelease`. These fire at the SDK
 *    call site (before / after the HTTP request), so handlers can
 *    observe — and, for `beforeAgentSpawn`, *modify* — the spawn input
 *    before it reaches the broker.
 *
 * The `beforeAgentSpawn` contract is the only one that supports
 * mutation: handlers may return a {@link SpawnPatch} to merge into the
 * input via shallow merge in registration order. All other hooks are
 * observe-only — return type `void | Promise<void>`.
 *
 * Types from `relay.ts` are pulled in with `import type` to avoid a
 * runtime circular import; TypeScript erases type-only imports so the
 * runtime dependency graph stays unidirectional
 * (`relay.ts` → `event-bus.ts` → no further).
 */

import type { BrokerEvent } from './protocol.js';
import type { Agent, AgentActivityChange, AgentResult, Message } from './relay.js';
import type { SpawnAgentResult, SpawnPtyInput, SpawnProviderInput } from './types.js';

// ── SpawnPatch ─────────────────────────────────────────────────────────────

/**
 * The subset of {@link SpawnPtyInput} / {@link SpawnProviderInput} fields a
 * `beforeAgentSpawn` handler may patch. Keeping this narrower than the full
 * input type stops handlers from rewriting identity (`name`, `cli`,
 * `provider`, `cwd`) — those need to come from the caller.
 *
 * For array fields (`args`, `channels`) a patch *replaces* the array. To
 * extend rather than replace, spread the current value:
 *
 * ```ts
 * relay.addListener('beforeAgentSpawn', (ctx) => ({
 *   args: [...(ctx.input.args ?? []), '--session-id', uuid],
 * }));
 * ```
 *
 * When multiple handlers return patches, they merge in registration order
 * via shallow `Object.assign` — later handlers override earlier ones for
 * the same key.
 */
export type SpawnPatch = Partial<
  Pick<
    SpawnPtyInput & SpawnProviderInput,
    'args' | 'channels' | 'task' | 'model' | 'team' | 'agentToken' | 'harnessConfig'
  >
>;

// ── Call-site contexts ─────────────────────────────────────────────────────

export interface BeforeAgentSpawnContext {
  /** Which spawn API was called. */
  kind: 'pty' | 'provider';
  /** Raw input the caller passed in. Treat as read-only — return a {@link SpawnPatch} to modify. */
  input: Readonly<SpawnPtyInput | SpawnProviderInput>;
  /** `process.pid` of the calling Node process. Useful for burn-style stamping. */
  spawnerPid: number;
  /** ISO timestamp captured the instant the hook chain started. */
  spawnStartTs: string;
  /** Resolved broker base URL the spawn will POST to. */
  baseUrl: string;
}

export type BeforeAgentSpawnHandler = (
  ctx: BeforeAgentSpawnContext
) => void | SpawnPatch | Promise<void | SpawnPatch>;

export interface AfterAgentSpawnContext extends BeforeAgentSpawnContext {
  /** Final input that was sent to the broker — original input merged with every handler's patch. */
  resolvedInput: SpawnPtyInput | SpawnProviderInput;
  /** Broker reply on success. */
  result?: SpawnAgentResult;
  /** Set when the broker call rejected. Mutually exclusive with `result`. */
  error?: Error;
  /** Wall-clock duration from `beforeAgentSpawn` start to here. */
  durationMs: number;
}

export interface BeforeAgentReleaseContext {
  name: string;
  reason?: string;
  baseUrl: string;
}

export interface AfterAgentReleaseContext extends BeforeAgentReleaseContext {
  error?: Error;
  durationMs: number;
}

// ── Broker-event payload shapes ────────────────────────────────────────────

export interface AgentIdlePayload {
  name: string;
  idleSecs: number;
}

export interface AgentExitRequestedPayload {
  name: string;
  reason: string;
}

export interface WorkerOutputPayload {
  name: string;
  stream: string;
  chunk: string;
}

/**
 * Object-shaped payload for channel subscribe / unsubscribe events. The
 * pre-2.x single-callback fields took two positional args
 * (`(agent, channels) => void`); the registry standardizes on an object
 * payload so all events share the one-arg shape and future fields can be
 * added without breaking handlers.
 */
export interface ChannelSubscriptionPayload {
  agent: string;
  channels: string[];
}

// ── Event map ──────────────────────────────────────────────────────────────

/**
 * Typed event map consumed by the {@link EventBus} that backs
 * `AgentRelay.addListener` / `removeListener`.
 *
 * Each entry's tuple is the handler argument list (always length 1 here —
 * payloads are objects rather than positional args).
 *
 * Declared as a `type` alias rather than an `interface` so it satisfies
 * the `EventBus<E extends EventMap>` constraint without requiring callers
 * to spell out an index signature.
 */
export type AgentRelayEvents = {
  // Broker events (multi-listener replacements for the old `on*` fields)
  messageReceived: [Message];
  messageSent: [Message];
  agentSpawned: [Agent];
  agentReleased: [Agent];
  agentExited: [Agent];
  agentReady: [Agent];
  workerOutput: [WorkerOutputPayload];
  deliveryUpdate: [BrokerEvent];
  agentExitRequested: [AgentExitRequestedPayload];
  agentIdle: [AgentIdlePayload];
  agentResult: [AgentResult];
  agentActivityChanged: [AgentActivityChange];
  channelSubscribed: [ChannelSubscriptionPayload];
  channelUnsubscribed: [ChannelSubscriptionPayload];

  // Call-site hooks (new)
  beforeAgentSpawn: [BeforeAgentSpawnContext];
  afterAgentSpawn: [AfterAgentSpawnContext];
  beforeAgentRelease: [BeforeAgentReleaseContext];
  afterAgentRelease: [AfterAgentReleaseContext];
};
