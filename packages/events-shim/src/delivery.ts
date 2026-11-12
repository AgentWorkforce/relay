import { EVENTS_SHIM_LIMITS } from './limits.js';
import type { EventsShimStore, ShimEvent, WakeTarget } from './types.js';
import { forwardWake } from './wake.js';

/** Delays between wake attempts for one post: immediately, then after 1s and 4s. */
export const WAKE_RETRY_DELAYS_MS: readonly number[] = [0, 1_000, 4_000];

/**
 * Waits before each recovery pass after a temporary failure left posts
 * pending. The first ones fit inside a Worker's post-response window; later
 * ones run only where the host process lives on (Node). Posts not delivered
 * by then wait for the next post, tool call or feed read.
 */
export const WAKE_RECOVERY_DELAYS_MS: readonly number[] = [10_000, 20_000, 120_000, 600_000];

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
  recoveryDelaysMs?: readonly number[];
  /** Keeps background work alive after the response (e.g. `ctx.waitUntil`). */
  defer?: (work: Promise<unknown>) => void;
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
      await deps.store.confirmWake(shimId, event.id, event.deliveredAt!, clock().toISOString());
      forwarded += 1;
      continue;
    }
    await deps.store.releaseWake(shimId, event.id, event.deliveredAt!, outcome.reason);
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

/**
 * Runs a delivery pass in the background and, if a temporary failure stalls
 * it, re-drains the backlog after each `WAKE_RECOVERY_DELAYS_MS` until a pass
 * finishes, the failure turns permanent, or the link changes (every claim
 * checks `target.linkedAt`). Hands the work to `deps.defer` when the host
 * gives one; otherwise it runs detached. Never throws.
 *
 * @param deps - The store, fetch, clock, sleep and optional `defer`.
 * @param shimId - The inbox whose posts to forward.
 * @param target - The wake link to forward to.
 * @param ids - Posts to forward first.
 * @param first - An already-running first pass to follow up on, instead of starting one.
 * @returns The background work, for hosts and tests that want to await it.
 */
export function deliverInBackground(
  deps: DeliveryDeps,
  shimId: string,
  target: WakeTarget,
  ids?: string[],
  first?: Promise<DeliveryPass>
): Promise<void> {
  const work = (async () => {
    let pass = await (first ?? deliverPending(deps, shimId, target, ids));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (const delay of deps.recoveryDelaysMs ?? WAKE_RECOVERY_DELAYS_MS) {
      if (!pass.stalled || pass.stalled.permanent) return;
      await sleep(delay);
      pass = await deliverPending(deps, shimId, target);
    }
  })().catch((error: unknown) => {
    console.warn('[events-shim] wake delivery failed', error instanceof Error ? error.name : 'error');
  });
  if (deps.defer) deps.defer(work);
  return work;
}

/** What a recovery sweep did. */
export interface WakeSweep {
  /** Inboxes the sweep re-drained. */
  shims: number;
  /** Posts forwarded across them. */
  forwarded: number;
  /** Inboxes whose relay still refused; the next sweep tries again (or the link is now marked broken). */
  stalled: number;
}

/**
 * Re-drains inboxes whose posts a temporary relay failure left pending, across
 * all inboxes, so a stalled post reaches an idle agent without waiting for the
 * next post. Hosts call it on a schedule (e.g. every minute). Each inbox gets
 * one attempt per post per sweep, without in-sweep retry delays; the next
 * sweep retries. Expired inboxes are skipped. Safe to run concurrently with
 * delivery passes: every post is claimed atomically under the current link.
 * The store picks inboxes in random order, so inboxes whose relay keeps
 * failing cannot keep later ones from being swept.
 *
 * @param deps - The store, fetch and clock.
 * @param options - `limit` inboxes per sweep (default `sweepShimLimit`) and `concurrency` (default 5).
 * @returns How many inboxes were re-drained, posts forwarded and inboxes still stalled.
 */
export async function recoverStalledWakes(
  deps: DeliveryDeps,
  options: { limit?: number; concurrency?: number } = {}
): Promise<WakeSweep> {
  const now = (deps.now ?? (() => new Date()))();
  const shims = await deps.store.listStalledWakes({
    staleBefore: new Date(now.getTime() - EVENTS_SHIM_LIMITS.sendLeaseMs).toISOString(),
    receivedBefore: new Date(now.getTime() - EVENTS_SHIM_LIMITS.sweepSettleMs).toISOString(),
    activeSince: new Date(now.getTime() - EVENTS_SHIM_LIMITS.idleExpiryMs).toISOString(),
    limit: options.limit ?? EVENTS_SHIM_LIMITS.sweepShimLimit,
  });
  const live = shims.filter(
    (shim) =>
      shim.wake &&
      !shim.wake.brokenAt &&
      now.getTime() - Date.parse(shim.lastUsedAt) < EVENTS_SHIM_LIMITS.idleExpiryMs
  );
  const sweep: WakeSweep = { shims: live.length, forwarded: 0, stalled: 0 };
  const single = { ...deps, retryDelaysMs: [0] };
  const queue = [...live];
  const workers = Array.from({ length: Math.max(1, options.concurrency ?? 5) }, async () => {
    for (let shim = queue.shift(); shim; shim = queue.shift()) {
      try {
        const pass = await deliverPending(single, shim.id, shim.wake!);
        sweep.forwarded += pass.forwarded;
        if (pass.stalled) sweep.stalled += 1;
      } catch {
        sweep.stalled += 1;
      }
    }
  });
  await Promise.all(workers);
  return sweep;
}
