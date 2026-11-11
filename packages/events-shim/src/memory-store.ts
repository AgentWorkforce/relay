import type { DeliveryState, EventsShimStore, NewShimEvent, SecretMode, ShimEvent, ShimRecord, WakeTarget } from './types.js';

interface Row {
  shim: ShimRecord;
  mcpTokenHash: string;
  hookTokenHash: string;
  manageTokenHash: string;
  posts: string[];
  events: ShimEvent[];
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

  async createShim(input: { id: string; mcpTokenHash: string; hookToken: string; hookTokenHash: string; manageTokenHash: string; now: string }): Promise<ShimRecord> {
    const shim: ShimRecord = { id: input.id, createdAt: input.now, lastUsedAt: input.now, hookToken: input.hookToken, secrets: {} };
    this.rows.set(input.id, {
      shim,
      mcpTokenHash: input.mcpTokenHash,
      hookTokenHash: input.hookTokenHash,
      manageTokenHash: input.manageTokenHash,
      posts: [],
      events: [],
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

  async countPostsSince(shimId: string, since: string) {
    return this.row(shimId).posts.filter((at) => at >= since).length;
  }

  async recordPost(shimId: string, at: string) {
    const row = this.row(shimId);
    row.posts.push(at);
    // Keep only a day of post times; nothing older is ever counted.
    const dayAgo = new Date(Date.parse(at) - 24 * 60 * 60 * 1000).toISOString();
    row.posts = row.posts.filter((post) => post >= dayAgo);
  }

  async appendEvent(shimId: string, input: NewShimEvent, feedSize: number) {
    const row = this.row(shimId);
    if (input.idempotencyKey) {
      const existing = row.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing) return { event: structuredClone(existing), duplicate: true };
    }
    const event: ShimEvent = { ...input, id: crypto.randomUUID(), shimId, seq: row.nextSeq, delivery: 'pending' };
    row.nextSeq += 1;
    row.events.push(event);
    if (row.events.length > feedSize) row.events.splice(0, row.events.length - feedSize);
    return { event: structuredClone(event), duplicate: false };
  }

  async listRecent(shimId: string, limit: number) {
    return structuredClone(this.row(shimId).events.slice(-limit).reverse());
  }

  async listUndelivered(shimId: string, limit: number, includeWoken: boolean) {
    return structuredClone(
      this.row(shimId)
        .events.filter((event) => event.delivery === 'pending' || (includeWoken && event.delivery === 'woken'))
        .slice(0, limit),
    );
  }

  async markDelivery(shimId: string, eventIds: string[], state: DeliveryState, at: string, wakeError?: string) {
    for (const event of this.row(shimId).events) {
      if (!eventIds.includes(event.id)) continue;
      // A wake result that lands after the agent read the post must not hand it over again.
      if (event.delivery === 'read' && state !== 'read') continue;
      event.delivery = state;
      if (state === 'pending') {
        if (wakeError) event.wakeError = wakeError;
      } else {
        event.deliveredAt = at;
        delete event.wakeError;
      }
    }
  }

  async prune(input: { idleBefore: string; feedBefore: string }) {
    for (const [id, row] of this.rows) {
      if (row.shim.lastUsedAt < input.idleBefore) this.rows.delete(id);
      else if (row.shim.lastUsedAt < input.feedBefore) row.events = [];
    }
  }
}
