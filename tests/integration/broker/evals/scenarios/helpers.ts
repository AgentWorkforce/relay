/**
 * Shared orchestration helpers for eval scenarios.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver';

import type { BrokerHarness } from '../../utils/broker-harness.js';

/** Time to let a freshly-spawned CLI boot and connect its MCP server. */
export const STARTUP_MS = 15_000;
/** How long to wait for an agent to respond to a stimulus before scoring. */
export const RESPONSE_MS = 60_000;
/** Extended response window for verbose/slow models (opus-class) that take longer to reason and respond. */
export const RESPONSE_MS_SLOW = 120_000;

/** Return the appropriate response window for a given model. Opus responses are verbose and take longer. */
export function responseMs(model?: string): number {
  if (!model) return RESPONSE_MS;
  const m = model.toLowerCase();
  return m.includes('opus') ? RESPONSE_MS_SLOW : RESPONSE_MS;
}

/**
 * Wait until `agent` has emitted at least `count` `relay_inbound` events, or the
 * timeout elapses. Resolves either way (scoring inspects the captured events).
 *
 * Polls against a single hard deadline. (A per-event waiter loop would busy-spin
 * here: the harness resolves an already-buffered match instantly, so when an
 * agent sends fewer than `count` messages the loop never advances and the
 * per-call timeout never fires.)
 */
export async function waitForSends(
  harness: BrokerHarness,
  agent: string,
  count: number,
  timeoutMs: number
): Promise<void> {
  const seen = () =>
    harness
      .getEvents()
      .filter(
        (e): e is Extract<BrokerEvent, { kind: 'relay_inbound' }> =>
          e.kind === 'relay_inbound' && e.from === agent
      ).length;
  const deadline = Date.now() + timeoutMs;
  while (seen() < count) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
