/**
 * Token bucket rate limiter for per-agent message throttling.
 *
 * Uses a token bucket algorithm that allows bursting while enforcing
 * an average rate limit. Generous defaults to avoid blocking legitimate
 * agent communication.
 */

export interface RateLimitConfig {
  /** Messages allowed per second (sustained rate). Default: 500 */
  messagesPerSecond: number;
  /** Maximum burst size (tokens in bucket). Default: 1000 */
  burstSize: number;
  /** Whether to log rate limit events. Default: true */
  logEvents: boolean;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  // Very generous defaults - 500/sec sustained, 1000 burst
  // This allows agents to send in bursts without being throttled
  messagesPerSecond: 500,
  burstSize: 1000,
  logEvents: true,
};

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterMs?: number;
}

export class RateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  }

  /**
   * Try to acquire a token for the given agent.
   * Returns true if the message should be allowed, false if rate limited.
   */
  tryAcquire(agentName: string): boolean {
    return this.tryAcquireWithResult(agentName).allowed;
  }

  /**
   * Try to acquire a token with detailed result.
   */
  tryAcquireWithResult(agentName: string): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(agentName);

    if (!bucket) {
      // New agent - start with full bucket
      bucket = {
        tokens: this.config.burstSize,
        lastRefill: now,
      };
      this.buckets.set(agentName, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsedMs = now - bucket.lastRefill;
    const tokensToAdd = (elapsedMs / 1000) * this.config.messagesPerSecond;
    bucket.tokens = Math.min(this.config.burstSize, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remainingTokens: Math.floor(bucket.tokens),
      };
    }

    // Rate limited - calculate retry time
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil((tokensNeeded / this.config.messagesPerSecond) * 1000);

    if (this.config.logEvents) {
      console.warn(
        `[rate-limiter] Agent ${agentName} rate limited, retry in ${retryAfterMs}ms`
      );
    }

    return {
      allowed: false,
      remainingTokens: 0,
      retryAfterMs,
    };
  }

  /**
   * Get remaining tokens for an agent (for monitoring/debugging).
   */
  getRemainingTokens(agentName: string): number {
    const bucket = this.buckets.get(agentName);
    if (!bucket) return this.config.burstSize;

    // Calculate current tokens with refill
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    const tokensToAdd = (elapsedMs / 1000) * this.config.messagesPerSecond;
    return Math.min(this.config.burstSize, Math.floor(bucket.tokens + tokensToAdd));
  }

  /**
   * Reset rate limit for an agent (useful for testing or admin override).
   */
  reset(agentName: string): void {
    this.buckets.delete(agentName);
  }

  /**
   * Reset all rate limits.
   */
  resetAll(): void {
    this.buckets.clear();
  }

  /**
   * Get rate limiter statistics.
   */
  getStats(): { agentCount: number; config: RateLimitConfig } {
    return {
      agentCount: this.buckets.size,
      config: this.config,
    };
  }

  /**
   * Clean up stale buckets (agents that haven't sent messages in a while).
   * Call periodically to prevent memory growth.
   */
  cleanup(maxAgeMs: number = 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [agentName, bucket] of this.buckets) {
      if (now - bucket.lastRefill > maxAgeMs) {
        this.buckets.delete(agentName);
        cleaned++;
      }
    }

    return cleaned;
  }
}

/**
 * No-op rate limiter for when rate limiting is disabled.
 */
export class NoOpRateLimiter extends RateLimiter {
  constructor() {
    super({ messagesPerSecond: Infinity, burstSize: Infinity, logEvents: false });
  }

  tryAcquire(_agentName: string): boolean {
    return true;
  }

  tryAcquireWithResult(_agentName: string): RateLimitResult {
    return { allowed: true, remainingTokens: Infinity };
  }
}
