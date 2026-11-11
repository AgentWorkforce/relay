/**
 * Limits every events-shim host enforces. They are part of the public
 * contract (the try page and the MCP instructions quote them), so hosts
 * read them from here instead of choosing their own.
 */
export const EVENTS_SHIM_LIMITS = Object.freeze({
  /** Accepted posts per webhook in any rolling hour. */
  postsPerHour: 60,
  /** Accepted posts per webhook in any rolling day. */
  postsPerDay: 500,
  /** Largest accepted request body, in bytes. */
  maxBodyBytes: 64 * 1024,
  /** A shim nobody has used (posted to, or called from MCP) for this long expires. */
  idleExpiryMs: 7 * 24 * 60 * 60 * 1000,
  /** Posts the feed keeps per shim; older ones are pruned. */
  feedSize: 50,
  /** How long the feed keeps posts after the shim was last used. */
  feedRetentionMs: 24 * 60 * 60 * 1000,
  /** Most posts one tool call hands to the agent; the rest wait for the next call. */
  batchSize: 20,
  /** Longest a `wait_for_webhook` call blocks before returning empty. */
  maxWaitMs: 50_000,
  /** Default `wait_for_webhook` block when the agent names none. */
  defaultWaitMs: 45_000,
  /** Characters of a post's body included in the wake message itself. */
  wakePreviewChars: 6_000,
  /** Longest accepted Idempotency-Key header. */
  maxIdempotencyKeyLength: 200,
  /** How long a wake claim (`sending`) lasts before another delivery may take the post. */
  sendLeaseMs: 2 * 60 * 1000,
  /** A post younger than this is left to its own delivery pass, not the recovery sweep. */
  sweepSettleMs: 30_000,
  /** Most inboxes one recovery sweep re-drains. */
  sweepShimLimit: 25,
  /** How long an idempotency key keeps a retried post from arriving twice. */
  dedupeWindowMs: 24 * 60 * 60 * 1000,
  /** Accepted clock skew for timestamped signatures (Stripe, Linear). */
  signatureToleranceMs: 5 * 60 * 1000,
});

export type EventsShimLimits = typeof EVENTS_SHIM_LIMITS;
