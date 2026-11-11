import { EVENTS_SHIM_LIMITS } from './limits.js';
import type { EventsShimStore, ShimEvent, WakeTarget } from './types.js';
import { forwardWake } from './wake.js';

/** Delays between wake attempts for one post: immediately, then after 1s and 4s. */
export const WAKE_RETRY_DELAYS_MS: readonly number[] = [0, 1_000, 4_000];

/** What a delivery pass did. */
export interface DeliveryPass {
  /** Posts forwarded to the agent's relay (and so marked `woken`). */
  forwarded: number;
  /** Set when a forward failed after its retries; the post went back to `pending`. */
  stalled?: { permanent: boolean; reason: string };
}

/** Dependencies of a delivery pass. */
export interface DeliveryDeps {
  store: EventsShimStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Replaces the retry wait; tests pass one that does not sleep. */
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

/**
 * Forwards pending posts to the agent's relay one at a time, oldest first.
 * Each post is claimed atomically (a `sending` lease) before it is sent and
 * confirmed `woken` only after Relaycast accepted it, so a host that stops
 * mid-send leaves at most one post on an expiring lease, never a post that
 * looks delivered. Every claim also requires `target` to still be the
 * current, unbroken link, so a pass for an unlinked or replaced link stops at
 * its next post. With `ids` it sends those posts first, then drains any older
 * backlog. A post whose forward fails after the retries goes back to
 * `pending`; a permanent refusal marks the link broken, but only if `target`
 * is still the current link.
 *
 * @param deps - The store, fetch and clock to use.
 * @param shimId - The inbox whose posts to forward.
 * @param target - The wake link to forward to.
 * @param ids - Posts to forward first; omit to drain the backlog only.
 * @returns How many posts were forwarded, and why it stopped early if it did.
 */
export async function deliverPending(
  deps: DeliveryDeps,
  shimId: string,
  target: WakeTarget,
  ids?: string[]
): Promise<DeliveryPass> {
  const clock = deps.now ?? (() => new Date());
  let forwarded = 0;
  const first = [...(ids ?? [])];
  for (;;) {
    const at = clock();
    const staleBefore = new Date(at.getTime() - EVENTS_SHIM_LIMITS.sendLeaseMs).toISOString();
    const id = first.shift();
    const [event] = await deps.store.claimPending(
      shimId,
      { limit: 1, staleBefore, linkedAt: target.linkedAt, ...(id ? { ids: [id] } : {}) },
      'sending',
      at.toISOString()
    );
    if (!event) {
      if (id) continue; // already taken or read; move on to the backlog
      return { forwarded };
    }
    const outcome = await forwardWithRetry(deps, target, event);
    if (outcome.ok) {
      await deps.store.confirmWake(shimId, event.id, clock().toISOString());
      forwarded += 1;
      continue;
    }
    await deps.store.releaseWake(shimId, event.id, outcome.reason);
    if (outcome.permanent) {
      await deps.store.markWakeBroken(shimId, target.linkedAt, outcome.reason, clock().toISOString());
    }
    return { forwarded, stalled: { permanent: outcome.permanent, reason: outcome.reason } };
  }
}

async function forwardWithRetry(
  deps: DeliveryDeps,
  target: WakeTarget,
  event: ShimEvent
): Promise<{ ok: true } | { ok: false; permanent: boolean; reason: string }> {
  const delays = deps.retryDelaysMs ?? WAKE_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: { ok: false; permanent: boolean; reason: string } = {
    ok: false,
    permanent: false,
    reason: 'not sent',
  };
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const sent = await forwardWake({
      url: target.url,
      secret: target.secret,
      event,
      fetchImpl: deps.fetchImpl,
    });
    if (sent.ok) return sent;
    last = sent;
    if (sent.permanent) break;
  }
  return last;
}
