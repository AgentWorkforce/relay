/**
 * Snowflake ID generator — time-sortable, globally unique identifiers.
 *
 * Inspired by Discord's Snowflake IDs (which are based on Twitter's).
 * Layout (64 bits):
 *   [41 bits: ms since epoch] [10 bits: worker] [12 bits: sequence]
 *
 * Properties:
 *   - IDs are time-sortable (newer messages have larger IDs)
 *   - Embedded timestamp (no separate created_at column needed for ordering)
 *   - Cursor-based pagination: use `before`/`after` with Snowflake IDs
 *   - Generates up to 4096 unique IDs per millisecond per worker
 */

/** Epoch: January 1, 2025 00:00:00 UTC */
const EPOCH = 1735689600000n;

const WORKER_ID = 0n;
const WORKER_BITS = 10n;
const SEQUENCE_BITS = 12n;
const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n; // 0xFFF

let lastTimestamp = 0n;
let sequence = 0n;

/**
 * Generate a new Snowflake ID.
 * @returns String representation of a 64-bit Snowflake ID
 */
export function snowflake(): string {
  let now = BigInt(Date.now()) - EPOCH;

  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & SEQUENCE_MASK;
    if (sequence === 0n) {
      // Sequence overflow — spin until next millisecond
      while (BigInt(Date.now()) - EPOCH <= lastTimestamp) {
        // busy wait
      }
      now = BigInt(Date.now()) - EPOCH;
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = now;

  const id =
    (now << (WORKER_BITS + SEQUENCE_BITS)) |
    (WORKER_ID << SEQUENCE_BITS) |
    sequence;

  return id.toString();
}

/**
 * Extract the creation timestamp (ms since Unix epoch) from a Snowflake ID.
 */
export function snowflakeToTimestamp(id: string): number {
  const big = BigInt(id);
  const msSinceEpoch = big >> (WORKER_BITS + SEQUENCE_BITS);
  return Number(msSinceEpoch + EPOCH);
}

/**
 * Create a Snowflake ID from a Unix timestamp (for range queries).
 * The returned ID is the minimum possible ID for that timestamp.
 */
export function timestampToSnowflake(timestamp: number): string {
  const msSinceEpoch = BigInt(timestamp) - EPOCH;
  const id = msSinceEpoch << (WORKER_BITS + SEQUENCE_BITS);
  return id.toString();
}
