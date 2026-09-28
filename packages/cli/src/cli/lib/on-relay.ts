import type { AgentRelayAgent } from '@agent-relay/sdk';

import {
  createHarnessInjector,
  resolveCodingSessionTarget,
  type CodingSessionHarness,
  type CodingSessionTarget,
  type DeliveryInjector,
  type ResolveCodingSessionTargetOptions,
} from '../../lib/coding-session-injector.js';
import {
  defaultDeliveryStateFile,
  runDurableSessionDelivery,
  type DeliveryRelay,
} from '../../lib/durable-session-delivery.js';

export {
  claudePeerFrames,
  createHarnessInjector,
  injectClaudeTerminal,
  injectCodex,
  type DeliveryInjector,
  type InjectionOutcome,
} from '../../lib/coding-session-injector.js';
export {
  DeliveryDrainer,
  DeliveryLedger,
  defaultDeliveryStateFile as defaultOnRelayStateFile,
  labeledDeliveryText,
  LedgerLockBusyError,
  messageReference,
  runDurableSessionDelivery,
  type DeliveryItem,
  type DeliveryRelay,
} from '../../lib/durable-session-delivery.js';

export type OnRelayHarness = CodingSessionHarness;
export type OnRelayTarget = CodingSessionTarget;
export type ResolveOnRelayTargetOptions = ResolveCodingSessionTargetOptions;

const DEFAULT_BASE_URL = 'https://cast.agentrelay.com';

export interface OnRelayIdentity {
  id: string;
  name: string;
  relay: DeliveryRelay;
}

export function normalizeAgentName(value: string): string {
  const name = value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(name) || name.includes('--')) {
    throw new Error('Agent name must be 2-48 lowercase letters, digits, or single dashes.');
  }
  if (name.length < 2) {
    throw new Error('Agent name must be 2-48 lowercase letters, digits, or single dashes.');
  }
  return name;
}

export function validateOnRelayBaseUrl(value: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(value ?? DEFAULT_BASE_URL);
  } catch {
    throw new Error('The Relaycast base URL is invalid.');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))
  ) {
    throw new Error('The Relaycast base URL must be an HTTPS origin (HTTP is allowed only on localhost).');
  }
  return parsed.origin;
}

export interface RunOnRelayListenerOptions {
  identity: OnRelayIdentity;
  target: OnRelayTarget;
  stateFile?: string;
  signal: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  injector?: DeliveryInjector;
  pollIntervalMs?: number;
}

/** Thin command adapter over the SDK-owned direct-node delivery stream. */
export async function runOnRelayListener(options: RunOnRelayListenerOptions): Promise<void> {
  await runDurableSessionDelivery({
    relay: options.identity.relay,
    stateFile: options.stateFile ?? defaultDeliveryStateFile(options.identity.name, options.identity.id),
    injector:
      options.injector ??
      createHarnessInjector({ harness: options.target.harness, sessionId: options.target.sessionId }),
    agentName: options.identity.name,
    sessionId: options.target.sessionId,
    signal: options.signal,
    log: options.log,
    warn: options.warn,
    pollIntervalMs: options.pollIntervalMs,
  });
}

/** Narrow a live SDK agent client to its durable-delivery surface. */
export function asDeliveryRelay(relay: AgentRelayAgent): DeliveryRelay {
  return relay.messaging as unknown as DeliveryRelay;
}

// Kept as a named binding so existing internal callers retain the old API.
export const resolveOnRelayTarget = resolveCodingSessionTarget;
