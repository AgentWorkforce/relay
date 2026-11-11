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
  setWakeTarget(shimId: string, target: WakeTarget | null): Promise<void>;
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
   * Stores a post unless one with the same idempotency key exists for the
   * shim; then returns that one with `duplicate: true`. Assigns `seq`,
   * starts `delivery` at `pending`, and prunes beyond `feedSize`.
   */
  appendEvent(
    shimId: string,
    event: NewShimEvent,
    feedSize: number
  ): Promise<{ event: ShimEvent; duplicate: boolean }>;
  /** Newest first, at most `limit`. */
  listRecent(shimId: string, limit: number): Promise<ShimEvent[]>;
  /** Oldest first: `pending` events, plus `woken` ones when `includeWoken`. */
  listUndelivered(shimId: string, limit: number, includeWoken: boolean): Promise<ShimEvent[]>;
  /**
   * Sets the delivery state, moving only forward: `pending → woken → read`.
   * `woken` never overwrites `read`, and `pending` (a failed wake, with
   * `wakeError`) applies only to events still `pending`, so a late or
   * overlapping wake result can never hand a post over twice.
   */
  markDelivery(
    shimId: string,
    eventIds: string[],
    state: DeliveryState,
    at: string,
    wakeError?: string
  ): Promise<void>;
  /** Deletes shims idle since before `idleBefore`, and feed rows older than `feedBefore` on idle shims. */
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
