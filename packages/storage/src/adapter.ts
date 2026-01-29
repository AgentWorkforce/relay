import type { PayloadKind, SendMeta } from '@agent-relay/protocol/types';
import path from 'node:path';

export type MessageStatus = 'unread' | 'read' | 'acked' | 'failed';

/**
 * Lightweight storage health report for the daemon/CLI.
 * - persistent: true when data is durable across restarts
 * - driver: backing implementation identifier
 * - canRead/canWrite: simple capability probes
 * - error: optional guidance or last failure reason
 */
export interface StorageHealth {
  persistent: boolean;
  driver: 'sqlite' | 'jsonl' | 'memory';
  canWrite: boolean;
  canRead: boolean;
  error?: string;
}

export interface StoredMessage {
  id: string;
  ts: number;
  from: string;
  to: string;
  topic?: string;
  kind: PayloadKind;
  body: string;
  data?: Record<string, unknown>;
  /** Optional metadata (importance, replyTo, etc.) */
  payloadMeta?: SendMeta;
  /** Optional thread ID for grouping related messages */
  thread?: string;
  deliverySeq?: number;
  deliverySessionId?: string;
  sessionId?: string;
  /** Per-recipient message status */
  status: MessageStatus;
  /** Whether the message is marked as urgent */
  is_urgent: boolean;
  /** Whether the message was sent as a broadcast (to: '*') */
  is_broadcast?: boolean;
  /** Number of replies in this thread (when message.id is used as thread) */
  replyCount?: number;
}

export interface MessageQuery {
  limit?: number;
  sinceTs?: number;
  from?: string;
  to?: string;
  topic?: string;
  /** Filter by thread ID */
  thread?: string;
  order?: 'asc' | 'desc';
  /** Only include unread messages */
  unreadOnly?: boolean;
  /** Only include urgent messages */
  urgentOnly?: boolean;
}

export interface StoredSession {
  id: string;
  agentName: string;
  cli?: string;
  projectId?: string;
  projectRoot?: string;
  startedAt: number;
  endedAt?: number;
  messageCount: number;
  summary?: string;
  resumeToken?: string;
  /** How the session was closed: 'agent' (explicit), 'disconnect', 'error', or undefined (still active) */
  closedBy?: 'agent' | 'disconnect' | 'error';
}

export interface SessionQuery {
  agentName?: string;
  projectId?: string;
  since?: number;
  limit?: number;
}

export interface AgentSummary {
  agentName: string;
  projectId?: string;
  lastUpdated: number;
  currentTask?: string;
  completedTasks?: string[];
  decisions?: string[];
  context?: string;
  files?: string[];
}

export interface StorageAdapter {
  init(): Promise<void>;
  healthCheck(): Promise<StorageHealth>;
  saveMessage(message: StoredMessage): Promise<void>;
  getMessages(query?: MessageQuery): Promise<StoredMessage[]>;
  getMessageById?(id: string): Promise<StoredMessage | null>;
  updateMessageStatus?(id: string, status: MessageStatus): Promise<void>;
  close?(): Promise<void>;

  // Session management (optional - for adapters that support it)
  startSession?(session: Omit<StoredSession, 'messageCount'>): Promise<void>;
  endSession?(sessionId: string, options?: { summary?: string; closedBy?: 'agent' | 'disconnect' | 'error' }): Promise<void>;
  getSessions?(query?: SessionQuery): Promise<StoredSession[]>;
  getRecentSessions?(limit?: number): Promise<StoredSession[]>;
  incrementSessionMessageCount?(sessionId: string): Promise<void>;
  getSessionByResumeToken?(resumeToken: string): Promise<StoredSession | null>;

  // Agent summaries (optional - for adapters that support it)
  saveAgentSummary?(summary: Omit<AgentSummary, 'lastUpdated'>): Promise<void>;
  getAgentSummary?(agentName: string): Promise<AgentSummary | null>;
  getAllAgentSummaries?(): Promise<AgentSummary[]>;

  // Delivery resume helpers (optional)
  getPendingMessagesForSession?(agentName: string, sessionId: string): Promise<StoredMessage[]>;
  getMaxSeqByStream?(agentName: string, sessionId: string): Promise<Array<{ peer: string; topic?: string; maxSeq: number }>>;

  // Channel membership helpers (optional)
  /** Get channels that an agent is a member of (based on stored membership events) */
  getChannelMembershipsForAgent?(memberName: string): Promise<string[]>;

  // Agent cleanup helpers (optional)
  /** Remove an agent from sessions table */
  removeAgent?(agentName: string): Promise<void>;
  /** Remove all messages from/to an agent */
  removeMessagesForAgent?(agentName: string): Promise<void>;
}

/**
 * Storage configuration options.
 * Can be set via CLI options or environment variables.
 */
export interface StorageConfig {
  /** Storage type: 'sqlite', 'sqlite-batched', 'jsonl', 'none', or 'postgres' (future) */
  type?: string;
  /** Path for SQLite database */
  path?: string;
  /** Connection URL for database (postgres://..., mysql://...) */
  url?: string;
  /** Batch configuration for batched adapters */
  batch?: {
    maxBatchSize?: number;
    maxBatchDelayMs?: number;
    maxBatchBytes?: number;
    logBatches?: boolean;
  };
}

/**
 * In-memory storage adapter (no persistence).
 * Useful for testing or when persistence is not needed.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private messages: StoredMessage[] = [];
  private fallbackReason?: string;

  constructor(options?: { reason?: string }) {
    this.fallbackReason = options?.reason;
  }

  async init(): Promise<void> {
    // No initialization needed
  }

  async healthCheck(): Promise<StorageHealth> {
    return {
      persistent: false,
      driver: 'memory',
      canWrite: true,
      canRead: true,
      error: this.fallbackReason,
    };
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    this.messages.push(message);
    // Keep only last 1000 messages to prevent memory issues
    if (this.messages.length > 1000) {
      this.messages = this.messages.slice(-1000);
    }
  }

  async getMessages(query?: MessageQuery): Promise<StoredMessage[]> {
    let result = [...this.messages];

    if (query?.from) {
      result = result.filter(m => m.from === query.from);
    }
    if (query?.to) {
      result = result.filter(m => m.to === query.to);
    }
    if (query?.topic) {
      result = result.filter(m => m.topic === query.topic);
    }
    if (query?.thread) {
      result = result.filter(m => m.thread === query.thread);
    }
    if (query?.sinceTs) {
      result = result.filter(m => m.ts >= query.sinceTs!);
    }
    if (query?.unreadOnly) {
      result = result.filter(m => m.status === 'unread');
    }
    if (query?.urgentOnly) {
      result = result.filter(m => m.is_urgent);
    }

    if (query?.order === 'asc') {
      result.sort((a, b) => a.ts - b.ts);
    } else {
      result.sort((a, b) => b.ts - a.ts);
    }

    if (query?.limit) {
      result = result.slice(0, query.limit);
    }

    // Calculate replyCount for each message (count of messages where thread === message.id)
    return result.map(m => ({
      ...m,
      replyCount: this.messages.filter(msg => msg.thread === m.id).length,
    }));
  }

  async getMessageById(id: string): Promise<StoredMessage | null> {
    // Support both exact match and prefix match (for short IDs)
    const msg = this.messages.find(m => m.id === id || m.id.startsWith(id));
    if (!msg) return null;
    return {
      ...msg,
      replyCount: this.messages.filter(m => m.thread === msg.id).length,
    };
  }

  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    const msg = this.messages.find(m => m.id === id || m.id.startsWith(id));
    if (msg) {
      msg.status = status;
    }
  }

  async getPendingMessagesForSession(agentName: string, sessionId: string): Promise<StoredMessage[]> {
    return this.messages
      .filter(m => m.to === agentName && m.deliverySessionId === sessionId && m.status !== 'acked')
      .sort((a, b) => {
        // Preserve delivery order by sequence first, timestamp second for deterministic replays
        const seqA = mSeq(a);
        const seqB = mSeq(b);
        return seqA === seqB ? a.ts - b.ts : seqA - seqB;
      });

    function mSeq(msg: StoredMessage): number {
      return msg.deliverySeq ?? 0;
    }
  }

  async getMaxSeqByStream(agentName: string, sessionId: string): Promise<Array<{ peer: string; topic?: string; maxSeq: number }>> {
    const aggregates = new Map<string, { peer: string; topic?: string; maxSeq: number }>();

    for (const msg of this.messages) {
      if (msg.to !== agentName) continue;
      if (msg.deliverySessionId !== sessionId) continue;
      if (msg.deliverySeq === undefined || msg.deliverySeq === null) continue;

      const topic = msg.topic ?? 'default';
      const key = `${topic}:${msg.from}`;
      const current = aggregates.get(key);
      if (!current || msg.deliverySeq > current.maxSeq) {
        aggregates.set(key, { peer: msg.from, topic: msg.topic, maxSeq: msg.deliverySeq });
      }
    }

    return Array.from(aggregates.values());
  }

  async close(): Promise<void> {
    this.messages = [];
  }
}

/**
 * Get storage configuration from environment variables.
 */
export function getStorageConfigFromEnv(): StorageConfig {
  return {
    type: process.env.AGENT_RELAY_STORAGE_TYPE,
    path: process.env.AGENT_RELAY_STORAGE_PATH,
    url: process.env.AGENT_RELAY_STORAGE_URL,
  };
}

/**
 * Create a storage adapter based on configuration.
 *
 * Configuration priority:
 * 1. Explicit config passed to function
 * 2. Environment variables (AGENT_RELAY_STORAGE_TYPE, AGENT_RELAY_STORAGE_PATH, AGENT_RELAY_STORAGE_URL)
 * 3. Default: JSONL (no native dependencies)
 *
 * Fallback strategy:
 * - Default to JSONL (no native dependencies required)
 * - SQLite available via --storage=sqlite flag (requires better-sqlite3 or Node 22+)
 * - If all durable adapters fail, keep daemon running via memory (non-persistent) with guidance
 *
 * Supported storage types:
 * - 'jsonl' (default): Append-only JSONL files (no native deps)
 * - 'sqlite': SQLite file-based storage (requires better-sqlite3 or Node 22+)
 * - 'sqlite-batched': SQLite with buffered writes
 * - 'none' or 'memory': In-memory storage (no persistence)
 * - 'postgres': PostgreSQL (requires AGENT_RELAY_STORAGE_URL) - future
 */
export async function createStorageAdapter(
  dbPath: string,
  config?: StorageConfig
): Promise<StorageAdapter> {
  // Merge with env config, explicit config takes priority
  const envConfig = getStorageConfigFromEnv();
  const finalConfig: StorageConfig = {
    type: config?.type ?? envConfig.type ?? 'jsonl',
    path: config?.path ?? envConfig.path ?? dbPath,
    url: config?.url ?? envConfig.url,
  };

  const storageType = finalConfig.type?.toLowerCase();

  switch (storageType) {
    case 'none':
    case 'memory': {
      console.error('[storage] Using in-memory storage (no persistence)');
      const adapter = new MemoryStorageAdapter();
      await adapter.init();
      return adapter;
    }

    case 'postgres':
    case 'postgresql': {
      if (!finalConfig.url) {
        throw new Error(
          'PostgreSQL storage requires AGENT_RELAY_STORAGE_URL environment variable or --storage-url option'
        );
      }
      // Future: implement PostgreSQL adapter
      throw new Error(
        'PostgreSQL storage is not yet implemented. Use sqlite or none.'
      );
    }

    case 'sqlite-batched':
    case 'batched': {
      try {
        console.error('[storage] Using batched SQLite storage');
        const { BatchedSqliteAdapter } = await import('./batched-sqlite-adapter.js');
        const adapter = new BatchedSqliteAdapter({
          dbPath: finalConfig.path!,
          batch: finalConfig.batch,
        });
        await adapter.init();
        return adapter;
      } catch (err) {
        // SQLite failed - fall back to JSONL, then memory
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[storage] ⚠️  SQLite initialization failed:', errMsg);

        try {
          const { JsonlStorageAdapter } = await import('./jsonl-adapter.js');
          const baseDir = path.dirname(finalConfig.path!);
          console.warn('[storage] ⚠️  Falling back to JSONL storage (append-only files)');
          const adapter = new JsonlStorageAdapter({
            baseDir,
            reason: 'upgrade to Node.js 22+ or run: npm rebuild better-sqlite3',
          });
          await adapter.init();
          return adapter;
        } catch (jsonErr) {
          const jsonMsg = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
          console.warn('[storage] ⚠️  JSONL fallback failed:', jsonMsg);
          console.warn('[storage] ⚠️  Falling back to in-memory storage (messages will not persist across restarts)');
        }

        console.warn('[storage] To fix: upgrade to Node.js 22+ or run: npm rebuild better-sqlite3');
        const adapter = new MemoryStorageAdapter({
          reason: 'upgrade to Node.js 22+ or run: npm rebuild better-sqlite3',
        });
        await adapter.init();
        return adapter;
      }
    }

    case 'jsonl': {
      const { JsonlStorageAdapter } = await import('./jsonl-adapter.js');
      const baseDir = path.dirname(finalConfig.path!);
      console.error('[storage] Using JSONL storage');
      const adapter = new JsonlStorageAdapter({ baseDir });
      await adapter.init();
      return adapter;
    }

    case 'sqlite':
    default: {
      try {
        const { SqliteStorageAdapter } = await import('./sqlite-adapter.js');
        const adapter = new SqliteStorageAdapter({ dbPath: finalConfig.path! });
        await adapter.init();
        return adapter;
      } catch (err) {
        // SQLite failed (likely better-sqlite3 not built and Node < 22)
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('[storage] ⚠️  SQLite initialization failed:', errMsg);

        try {
          const { JsonlStorageAdapter } = await import('./jsonl-adapter.js');
          const baseDir = path.dirname(finalConfig.path!);
          console.warn('[storage] ⚠️  Falling back to JSONL storage (append-only files)');
          const adapter = new JsonlStorageAdapter({
            baseDir,
            reason: 'upgrade to Node.js 22+ or run: npm rebuild better-sqlite3',
          });
          await adapter.init();
          return adapter;
        } catch (jsonErr) {
          const jsonMsg = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
          console.warn('[storage] ⚠️  JSONL fallback failed:', jsonMsg);
          console.warn('[storage] ⚠️  Falling back to in-memory storage (messages will not persist across restarts)');
        }

        console.warn('[storage] To fix: upgrade to Node.js 22+ or run: npm rebuild better-sqlite3');
        const adapter = new MemoryStorageAdapter({
          reason: 'upgrade to Node.js 22+ or run: npm rebuild better-sqlite3',
        });
        await adapter.init();
        return adapter;
      }
    }
  }
}
