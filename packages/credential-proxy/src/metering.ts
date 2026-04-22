import type { MeteringRecord, ProxyTokenClaims, UsageSummary } from './types.js';

function createEmptyUsageSummary(): UsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
  };
}

function aggregateUsage(
  records: readonly MeteringRecord[],
  predicate?: (record: MeteringRecord) => boolean
): UsageSummary {
  return records.reduce<UsageSummary>((summary, record) => {
    if (predicate && !predicate(record)) {
      return summary;
    }

    summary.inputTokens += record.inputTokens;
    summary.outputTokens += record.outputTokens;
    summary.requests += 1;
    return summary;
  }, createEmptyUsageSummary());
}

function getConsumedBudget(summary: UsageSummary): number {
  return summary.inputTokens + summary.outputTokens;
}

export class MeteringCollector {
  private readonly buffer: MeteringRecord[] = [];
  private readonly pendingTokens = new Map<string, number>();

  record(entry: MeteringRecord): void {
    this.buffer.push({ ...entry });
  }

  /**
   * Reserve tokens against a workspace budget before forwarding the request.
   * This prevents concurrent requests from bypassing budget limits (TOCTOU).
   */
  reservePending(workspaceId: string, tokens: number): void {
    const current = this.pendingTokens.get(workspaceId) ?? 0;
    this.pendingTokens.set(workspaceId, current + tokens);
  }

  /**
   * Release a pending reservation (after metering the actual usage or on failure).
   */
  releasePending(workspaceId: string, tokens: number): void {
    const current = this.pendingTokens.get(workspaceId) ?? 0;
    const next = Math.max(0, current - tokens);
    if (next === 0) {
      this.pendingTokens.delete(workspaceId);
    } else {
      this.pendingTokens.set(workspaceId, next);
    }
  }

  getPendingTokens(workspaceId: string): number {
    return this.pendingTokens.get(workspaceId) ?? 0;
  }

  flush(): MeteringRecord[] {
    const flushed = this.buffer.map((entry) => ({ ...entry }));
    this.buffer.length = 0;

    // TODO: Replace the in-memory buffer with a durable backend flush target.
    return flushed;
  }

  getUsageByWorkspace(workspaceId: string): UsageSummary {
    return aggregateUsage(this.buffer, (record) => record.workspaceId === workspaceId);
  }

  getUsageByCredential(credentialId: string): UsageSummary {
    return aggregateUsage(this.buffer, (record) => record.credentialId === credentialId);
  }

  getTotalUsage(): UsageSummary {
    return aggregateUsage(this.buffer);
  }
}

export function checkBudget(
  claims: ProxyTokenClaims,
  collector: MeteringCollector
): { allowed: boolean; remaining?: number } {
  if (claims.budget === undefined) {
    return { allowed: true };
  }

  const usage = collector.getUsageByWorkspace(claims.sub);
  const consumed = getConsumedBudget(usage) + collector.getPendingTokens(claims.sub);
  const remaining = Math.max(0, claims.budget - consumed);

  return {
    allowed: consumed < claims.budget,
    remaining,
  };
}

/** Default pessimistic token reservation for in-flight requests. */
export const DEFAULT_BUDGET_RESERVATION = 4096;
