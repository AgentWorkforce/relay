import type {
  DeliveryState,
  EventsShimStore,
  NewShimEvent,
  SecretMode,
  ShimEvent,
  ShimRecord,
  WakeTarget,
} from './types.js';

interface Row {
  shim: ShimRecord;
  mcpTokenHash: string;
  hookTokenHash: string;
  manageTokenHash: string;
  posts: string[];
  events: ShimEvent[];
  /** Idempotency ledger, kept apart from the feed so pruning never forgets a key. */
  keys: Map<string, { eventId: string; seq: number; at: string }>;
  nextSeq: number;
}

/**
 * In-memory `EventsShimStore`: the reference implementation hosts'
 * database stores are tested against, and a store for single-process use.
 */
export class MemoryEventsShimStore implements EventsShimStore {
  private readonly rows = new Map<string, Row>();

  private row(id: string): Row {
    const row = this.rows.get(id);
    if (!row) throw new Error(`unknown shim ${id}`);
    return row;
  }

  private copy(row: Row): ShimRecord {
    return structuredClone(row.shim);
  }

  async createShim(input: {
    id: string;
    mcpTokenHash: string;
    hookToken: string;
    hookTokenHash: string;
    manageTokenHash: string;
    now: string;
  }): Promise<ShimRecord> {
    const shim: ShimRecord = {
      id: input.id,
      createdAt: input.now,
      lastUsedAt: input.now,
      hookToken: input.hookToken,
      secrets: {},
    };
    this.rows.set(input.id, {
      shim,
      mcpTokenHash: input.mcpTokenHash,
      hookTokenHash: input.hookTokenHash,
      manageTokenHash: input.manageTokenHash,
      posts: [],
      events: [],
      keys: new Map(),
      nextSeq: 1,
    });
    return structuredClone(shim);
  }

  private findBy(key: 'mcpTokenHash' | 'hookTokenHash' | 'manageTokenHash', hash: string): ShimRecord | null {
    for (const row of this.rows.values()) if (row[key] === hash) return this.copy(row);
    return null;
  }

  async findByMcpTokenHash(hash: string) {
    return this.findBy('mcpTokenHash', hash);
  }

  async findByHookTokenHash(hash: string) {
    return this.findBy('hookTokenHash', hash);
  }

  async findByManageTokenHash(hash: string) {
    return this.findBy('manageTokenHash', hash);
  }

  async rotateHookToken(shimId: string, hookToken: string, hookTokenHash: string) {
    const row = this.row(shimId);
    row.hookTokenHash = hookTokenHash;
    row.shim.hookToken = hookToken;
  }

  async setSecret(shimId: string, mode: SecretMode, secret: string | null) {
    const row = this.row(shimId);
    if (secret === null) delete row.shim.secrets[mode];
    else row.shim.secrets[mode] = secret;
  }

  async setWakeTarget(shimId: string, target: WakeTarget | null) {
    const row = this.row(shimId);
    if (target) row.shim.wake = { ...target };
    else delete row.shim.wake;
  }

  async touch(shimId: string, now: string, agent: boolean) {
    const row = this.row(shimId);
    row.shim.lastUsedAt = now;
    if (agent) row.shim.agentSeenAt = now;
  }

  async reservePost(
    shimId: string,
    at: string,
    windows: { since: string; limit: number; name: 'hour' | 'day' }[]
  ) {
    // Synchronous between the read and the write, so atomic in one process.
    const row = this.row(shimId);
    for (const window of windows) {
      if (row.posts.filter((post) => post >= window.since).length >= window.limit)
        return { ok: false as const, window: window.name };
    }
    row.posts.push(at);
    const dayAgo = new Date(Date.parse(at) - 24 * 60 * 60 * 1000).toISOString();
    row.posts = row.posts.filter((post) => post >= dayAgo);
    return { ok: true as const };
  }

  async markWakeBroken(shimId: string, linkedAt: string, reason: string, at: string) {
    const row = this.row(shimId);
    if (row.shim.wake && row.shim.wake.linkedAt === linkedAt) {
      row.shim.wake = { ...row.shim.wake, brokenAt: at, brokenReason: reason };
    }
  }

  async appendEvent(shimId: string, input: NewShimEvent, options: { feedSize: number; dedupeSince: string }) {
    const row = this.row(shimId);
    for (const [key, entry] of row.keys) if (entry.at < options.dedupeSince) row.keys.delete(key);
    if (input.idempotencyKey) {
      const seen = row.keys.get(input.idempotencyKey);
      if (seen) return { duplicate: true as const, eventId: seen.eventId, seq: seen.seq };
    }
    const event: ShimEvent = {
      ...input,
      id: crypto.randomUUID(),
      shimId,
      seq: row.nextSeq,
      delivery: 'pending',
    };
    row.nextSeq += 1;
    row.events.push(event);
    if (input.idempotencyKey)
      row.keys.set(input.idempotencyKey, { eventId: event.id, seq: event.seq, at: input.receivedAt });
    if (row.events.length > options.feedSize) row.events.splice(0, row.events.length - options.feedSize);
    return { duplicate: false as const, event: structuredClone(event) };
  }

  async listRecent(shimId: string, limit: number) {
    return structuredClone(this.row(shimId).events.slice(-limit).reverse());
  }

  async listStalledWakes(input: {
    staleBefore: string;
    receivedBefore: string;
    activeSince: string;
    limit: number;
  }) {
    const stalled: ShimRecord[] = [];
    for (const row of this.rows.values()) {
      if (!row.shim.wake || row.shim.wake.brokenAt || row.shim.lastUsedAt < input.activeSince) continue;
      if (
        row.events.some(
          (event) => claimable(event, input.staleBefore) && event.receivedAt < input.receivedBefore
        )
      ) {
        stalled.push(this.copy(row));
      }
    }
    // Random order, so failing inboxes cannot hold every slot run after run.
    for (let i = stalled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [stalled[i], stalled[j]] = [stalled[j]!, stalled[i]!];
    }
    return stalled.slice(0, Math.max(0, input.limit));
  }

  async countPending(shimId: string, staleBefore: string) {
    return this.row(shimId).events.filter((event) => claimable(event, staleBefore)).length;
  }

  async claimPending(
    shimId: string,
    options: { limit: number; ids?: string[]; staleBefore: string; linkedAt?: string },
    state: 'sending' | 'read',
    at: string
  ) {
    // Synchronous from read to write, so two callers can never claim the same post.
    const row = this.row(shimId);
    if (options.linkedAt !== undefined) {
      const wake = row.shim.wake;
      if (!wake || wake.brokenAt || wake.linkedAt !== options.linkedAt) return [];
    }
    const claimed: ShimEvent[] = [];
    for (const event of row.events) {
      if (claimed.length >= options.limit) break;
      if (!claimable(event, options.staleBefore)) continue;
      if (options.ids && !options.ids.includes(event.id)) continue;
      event.delivery = state;
      event.deliveredAt = at;
      delete event.wakeError;
      claimed.push(structuredClone(event));
    }
    return claimed;
  }

  async confirmWake(shimId: string, eventId: string, claimedAt: string, at: string) {
    const event = this.row(shimId).events.find((candidate) => candidate.id === eventId);
    if (event && event.delivery === 'sending' && event.deliveredAt === claimedAt) {
      event.delivery = 'woken';
      event.deliveredAt = at;
    }
  }

  async releaseWake(shimId: string, eventId: string, claimedAt: string, wakeError: string) {
    const event = this.row(shimId).events.find((candidate) => candidate.id === eventId);
    if (event && event.delivery === 'sending' && event.deliveredAt === claimedAt) {
      event.delivery = 'pending';
      delete event.deliveredAt;
      event.wakeError = wakeError;
    }
  }

  async prune(input: { idleBefore: string; feedBefore: string }) {
    for (const [id, row] of this.rows) {
      if (row.shim.lastUsedAt < input.idleBefore) this.rows.delete(id);
      else {
        if (row.shim.lastUsedAt < input.feedBefore) row.events = [];
        for (const [key, entry] of row.keys) if (entry.at < input.feedBefore) row.keys.delete(key);
      }
    }
  }
}

/** `pending`, or `sending` with a claim that expired before `staleBefore`. */
function claimable(event: ShimEvent, staleBefore: string): boolean {
  return (
    event.delivery === 'pending' || (event.delivery === 'sending' && (event.deliveredAt ?? '') < staleBefore)
  );
}
