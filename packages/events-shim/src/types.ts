/** How a webhook URL checks who posted to it. */
export type VerificationMode = 'open' | 'github' | 'stripe' | 'linear' | 'bearer';

export const VERIFICATION_MODES: readonly VerificationMode[] = [
  'open',
  'github',
  'stripe',
  'linear',
  'bearer',
];

/** Modes whose URL needs a stored secret before it accepts posts. */
export type SecretMode = Exclude<VerificationMode, 'open'>;

/**
 * Where a post is forwarded to wake the agent: the inbound webhook the
 * agent's own local Agent Relay created for its session (`POST /webhooks`
 * on the session socket). Relaycast puts a post there in a channel only
 * that session reads, and Agent Relay injects it into the session, waking
 * it when idle.
 */
export interface WakeTarget {
  /** `https://<relaycast>/v1/hooks/<id>`. */
  url: string;
  /** The `wh_live_…` bearer Relaycast showed once. Hosts store it encrypted. */
  secret: string;
  linkedAt: string;
  /** Set when the last forward was refused for good (revoked or deleted hook). */
  brokenAt?: string;
  brokenReason?: string;
}

/** One webhook inbox. Hosts persist this; tokens exist only as hashes. */
export interface ShimRecord {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  /**
   * The current webhook path token, decrypted by the host, so MCP tools can
   * tell the agent its own webhook URL. Lookups use its hash.
   */
  hookToken: string;
  /** Plaintext signing secrets per mode, decrypted by the host. */
  secrets: Partial<Record<SecretMode, string>>;
  wake?: WakeTarget;
  /** Set once an agent has called any shim tool. */
  agentSeenAt?: string;
}

/** What happened to a post after it was stored. */
export type DeliveryState =
  /**
   * Claimed by a wake that is sending it now. A lease: if the host stops
   * mid-send, the claim expires and the post is claimable again.
   */
  | 'sending'
  /** Forwarded to the agent's relay; Agent Relay injects it (waking an idle session). */
  | 'woken'
  /** Waiting for the agent: no wake link, or the forward failed. */
  | 'pending'
  /** Handed to the agent by `get_webhook_events` or `wait_for_webhook`. */
  | 'read';

export interface ShimEvent {
  id: string;
  shimId: string;
  /** Increases by one per accepted post within a shim. */
  seq: number;
  receivedAt: string;
  mode: VerificationMode;
  /** e.g. `pull_request.opened`, `invoice.paid`, `Issue.create`; absent for plain posts. */
  eventType?: string;
  idempotencyKey?: string;
  contentType: string;
  /** The raw body as text (at most `maxBodyBytes`). */
  body: string;
  /** A small allowlisted subset of request headers, for the agent's context. */
  headers: Record<string, string>;
  delivery: DeliveryState;
  deliveredAt?: string;
  /** Why the last wake forward failed, when it did. */
  wakeError?: string;
}

export type NewShimEvent = Omit<
  ShimEvent,
  'id' | 'seq' | 'shimId' | 'delivery' | 'deliveredAt' | 'wakeError'
>;

/**
 * Persistence the host provides. Cloud implements it with Drizzle,
 * relay-control with raw SQL; `MemoryEventsShimStore` is the reference.
 * Every method must be safe under concurrent requests for the same shim.
 */
export interface EventsShimStore {
  /** Creates a shim. `mcpTokenHash`/`hookTokenHash`/`manageTokenHash` are sha256 hex. */
  createShim(input: {
    id: string;
    mcpTokenHash: string;
    hookToken: string;
    hookTokenHash: string;
    manageTokenHash: string;
    now: string;
  }): Promise<ShimRecord>;
  findByMcpTokenHash(hash: string): Promise<ShimRecord | null>;
  findByHookTokenHash(hash: string): Promise<ShimRecord | null>;
  findByManageTokenHash(hash: string): Promise<ShimRecord | null>;
  /** Replaces the webhook token (old URL stops working at once). */
  rotateHookToken(shimId: string, hookToken: string, hookTokenHash: string): Promise<void>;
  setSecret(shimId: string, mode: SecretMode, secret: string | null): Promise<void>;
  /** Sets or clears the wake link (link_relay_wake / unlink_relay_wake). */
  setWakeTarget(shimId: string, target: WakeTarget | null): Promise<void>;
  /**
   * Marks the wake link broken, but only if the current link is still the
   * one linked at `linkedAt`: a late failure from an old link must never
   * overwrite a newer link or recreate a removed one.
   */
  markWakeBroken(shimId: string, linkedAt: string, reason: string, at: string): Promise<void>;
  /** Records that the shim was used now (extends idle expiry). */
  touch(shimId: string, now: string, agent: boolean): Promise<void>;
  /**
   * Atomically counts one post toward the shim's rate limits, unless either
   * window is already full. Must be atomic with respect to concurrent calls
   * for the same shim (e.g. lock the shim row, count, insert), so overlapping
   * posts cannot all pass the check. Duplicates count. Hosts may drop
   * records older than a day.
   */
  reservePost(
    shimId: string,
    at: string,
    windows: { since: string; limit: number; name: 'hour' | 'day' }[]
  ): Promise<{ ok: true } | { ok: false; window: 'hour' | 'day' }>;
  /**
   * Stores a post unless its idempotency key was seen for this shim since
   * `dedupeSince`; then returns the original's id and seq with
   * `duplicate: true`. Keys are kept in their own ledger, independent of
   * feed pruning, until they are older than `dedupeSince`. Assigns `seq`,
   * starts `delivery` at `pending`, and prunes the feed beyond `feedSize`.
   */
  appendEvent(
    shimId: string,
    event: NewShimEvent,
    options: { feedSize: number; dedupeSince: string }
  ): Promise<{ duplicate: false; event: ShimEvent } | { duplicate: true; eventId: string; seq: number }>;
  /** Newest first, at most `limit`. */
  listRecent(shimId: string, limit: number): Promise<ShimEvent[]>;
  /**
   * Inboxes the recovery sweep should re-drain: used since `activeSince` (not
   * expired), a wake link that is set and not broken, and at least one
   * claimable post (`pending`, or `sending` whose claim is older than
   * `staleBefore`) received before `receivedBefore`. At most `limit`, in
   * random order (`ORDER BY random()`), so inboxes whose relay keeps failing
   * cannot take every slot from later ones run after run.
   */
  listStalledWakes(input: {
    staleBefore: string;
    receivedBefore: string;
    activeSince: string;
    limit: number;
  }): Promise<ShimRecord[]>;
  /** How many posts the agent has not received: `pending`, plus `sending` claims that expired before `staleBefore`. */
  countPending(shimId: string, staleBefore: string): Promise<number>;
  /**
   * Atomically claims posts and returns exactly the posts this call claimed:
   * the oldest `limit`, or only `ids` when given. Claimable posts are
   * `pending` ones and `sending` ones whose claim (`deliveredAt`) is older
   * than `staleBefore` (an expired lease). Two concurrent callers never
   * receive the same post.
   *
   * With `linkedAt`, nothing is claimed unless the shim's current wake link
   * is the one linked at `linkedAt` and is not broken, checked in the same
   * atomic step, so a pass for a removed or replaced link stops.
   *
   * Postgres: pick the ids once in a `MATERIALIZED` CTE (`… FOR UPDATE SKIP
   * LOCKED`), then `UPDATE … FROM picked … RETURNING`; a plain
   * `WHERE id IN (SELECT … LIMIT n …)` can return more than `n` rows.
   */
  claimPending(
    shimId: string,
    options: { limit: number; ids?: string[]; staleBefore: string; linkedAt?: string },
    state: 'sending' | 'read',
    at: string
  ): Promise<ShimEvent[]>;
  /**
   * A sent post: `sending` → `woken`. Applies only while it is still the
   * same claim — `sending` with `deliveredAt === claimedAt` — so a sender
   * whose lease expired cannot touch a newer claim of the same post.
   */
  confirmWake(shimId: string, eventId: string, claimedAt: string, at: string): Promise<void>;
  /**
   * A post whose send failed: `sending` → `pending`, recording `wakeError`.
   * Applies only while it is still the same claim (`sending` with
   * `deliveredAt === claimedAt`).
   */
  releaseWake(shimId: string, eventId: string, claimedAt: string, wakeError: string): Promise<void>;
  /**
   * Deletes shims idle since before `idleBefore`, feed rows on shims idle
   * since before `feedBefore`, and idempotency keys older than `feedBefore`.
   */
  prune(input: { idleBefore: string; feedBefore: string }): Promise<void>;
}

/** Tokens returned once when a shim is created. Only hashes are stored. */
export interface MintedShim {
  shim: ShimRecord;
  /** Goes in the MCP URL: `<base>/t/<mcpToken>/mcp`. */
  mcpToken: string;
  /** Goes in the webhook URL: `<base>/h/<hookToken>`. */
  hookToken: string;
  /** Lets the page read the feed, rotate the URL and set secrets. */
  manageToken: string;
}

/** Host-specific URL shapes. */
export interface ShimUrls {
  mcpUrl(mcpToken: string): string;
  hookUrl(hookToken: string, mode: VerificationMode): string;
}
