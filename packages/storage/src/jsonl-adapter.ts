import fs from 'node:fs';
import path from 'node:path';
import {
  type MessageQuery,
  type MessageStatus,
  type SessionQuery,
  type StorageAdapter,
  type StorageHealth,
  type StoredMessage,
  type StoredSession,
} from './adapter.js';

export interface JsonlAdapterOptions {
  /** Base directory for storage (e.g., /path/to/.agent-relay) */
  baseDir: string;
  /** Message retention period in milliseconds (default: 7 days) */
  messageRetentionMs?: number;
  /** Auto-cleanup interval in milliseconds (default: 1 hour, 0 to disable) */
  cleanupIntervalMs?: number;
  /** Optional reason for falling back to JSONL (surfaced in health check) */
  reason?: string;
  /** Watch for file changes and auto-reload (default: false) */
  watchForChanges?: boolean;
  /** Debounce interval for file watching in milliseconds (default: 100ms) */
  watchDebounceMs?: number;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_WATCH_DEBOUNCE_MS = 100;

interface MessageRecord {
  type: 'message';
  message: StoredMessage;
}

interface StatusRecord {
  type: 'status';
  id: string;
  status: MessageStatus;
  ts: number;
}

interface DeleteRecord {
  type: 'delete';
  id: string;
  ts: number;
}

type MessageLogRecord = MessageRecord | StatusRecord | DeleteRecord;

type SessionRecord =
  | { type: 'session-start'; session: StoredSession }
  | { type: 'session-end'; id: string; endedAt: number; summary?: string; closedBy?: 'agent' | 'disconnect' | 'error' }
  | { type: 'session-increment'; id: string; delta: number };

/**
 * JSONL-based storage adapter used as a durable fallback when SQLite is unavailable.
 * Messages are written append-only to per-day JSONL files to keep write amplification low.
 */
export class JsonlStorageAdapter implements StorageAdapter {
  private baseDir: string;
  private messageDir: string;
  private sessionFile: string;
  private retentionMs: number;
  private cleanupIntervalMs: number;
  private cleanupTimer?: NodeJS.Timeout;
  private fallbackReason?: string;
  // Serialize writes to avoid interleaved JSON lines or session truncation
  private messageWriteChain: Promise<void> = Promise.resolve();
  private sessionLock: Promise<void> = Promise.resolve();

  private messages: Map<string, StoredMessage> = new Map();
  private deletedMessages: Set<string> = new Set();
  private sessions: Map<string, StoredSession> = new Map();
  private resumeIndex: Map<string, string> = new Map();

  private watchForChanges: boolean;
  private watchDebounceMs: number;
  private messageWatcher?: fs.FSWatcher;
  private sessionWatcher?: fs.FSWatcher;
  private reloadDebounceTimer?: NodeJS.Timeout;
  private sessionReloadDebounceTimer?: NodeJS.Timeout;

  constructor(options: JsonlAdapterOptions) {
    this.baseDir = options.baseDir;
    this.messageDir = path.join(this.baseDir, 'messages');
    this.sessionFile = path.join(this.baseDir, 'sessions.jsonl');
    this.retentionMs = options.messageRetentionMs ?? DEFAULT_RETENTION_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.fallbackReason = options.reason;
    this.watchForChanges = options.watchForChanges ?? false;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.messageDir, { recursive: true });
    await fs.promises.mkdir(this.baseDir, { recursive: true });

    await this.cleanupExpiredMessages();
    await this.loadMessagesFromDisk();
    await this.loadSessionsFromDisk();

    if (this.cleanupIntervalMs > 0) {
      this.startCleanupTimer();
    }

    if (this.watchForChanges) {
      this.startFileWatching();
    }
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.stopFileWatching();
    this.messages.clear();
    this.deletedMessages.clear();
    this.sessions.clear();
    this.resumeIndex.clear();
  }

  // ============ Message Handling ============

  async healthCheck(): Promise<StorageHealth> {
    const result: StorageHealth = {
      persistent: true,
      driver: 'jsonl',
      canRead: false,
      canWrite: false,
      error: this.fallbackReason,
    };

    try {
      await fs.promises.access(this.baseDir, fs.constants.R_OK);
      await fs.promises.access(this.baseDir, fs.constants.W_OK);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }

    // Quick write probe (non-destructive): touch a temp file under the baseDir
    const probePath = path.join(this.baseDir, '.jsonl-healthcheck.tmp');
    try {
      await fs.promises.appendFile(probePath, '');
      await fs.promises.unlink(probePath).catch(() => {});
      result.canWrite = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    // Read probe: ensure we can enumerate message files (covers basic read permissions)
    try {
      await fs.promises.readdir(this.messageDir);
      result.canRead = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    result.persistent = result.canRead && result.canWrite;
    return result;
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    const record: MessageRecord = { type: 'message', message };
    await this.appendMessageRecord(record);
    this.applyMessageRecord(record);
  }

  async getMessages(query: MessageQuery = {}): Promise<StoredMessage[]> {
    const msgs = Array.from(this.messages.values()).filter(msg => !this.deletedMessages.has(msg.id));

    let filtered = msgs;
    if (query.sinceTs !== undefined) {
      filtered = filtered.filter(m => m.ts >= query.sinceTs!);
    }
    if (query.from) {
      filtered = filtered.filter(m => m.from === query.from);
    }
    if (query.to) {
      filtered = filtered.filter(m => m.to === query.to);
    }
    if (query.topic) {
      filtered = filtered.filter(m => m.topic === query.topic);
    }
    if (query.thread) {
      filtered = filtered.filter(m => m.thread === query.thread);
    }
    if (query.unreadOnly) {
      filtered = filtered.filter(m => m.status === 'unread');
    }
    if (query.urgentOnly) {
      filtered = filtered.filter(m => m.is_urgent);
    }

    filtered.sort((a, b) => query.order === 'asc' ? a.ts - b.ts : b.ts - a.ts);

    const limit = query.limit ?? 200;
    const replyCounts = this.computeReplyCounts();

    return filtered.slice(0, limit).map(m => ({
      ...m,
      replyCount: replyCounts.get(m.id) ?? 0,
    }));
  }

  async getMessageById(id: string): Promise<StoredMessage | null> {
    const exact = this.messages.get(id);
    if (exact && !this.deletedMessages.has(id)) {
      return { ...exact, replyCount: this.computeReplyCounts().get(exact.id) ?? 0 };
    }

    const prefixMatches = Array.from(this.messages.values())
      .filter(m => !this.deletedMessages.has(m.id) && m.id.startsWith(id));

    if (prefixMatches.length === 0) return null;

    const replyCounts = this.computeReplyCounts();
    // Return most recent match
    const mostRecent = prefixMatches.sort((a, b) => b.ts - a.ts)[0];
    return { ...mostRecent, replyCount: replyCounts.get(mostRecent.id) ?? 0 };
  }

  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    const record: StatusRecord = { type: 'status', id, status, ts: Date.now() };
    await this.appendMessageRecord(record);
    this.applyMessageRecord(record);
  }

  async getPendingMessagesForSession(agentName: string, sessionId: string): Promise<StoredMessage[]> {
    const pending = Array.from(this.messages.values())
      .filter(m => !this.deletedMessages.has(m.id))
      .filter(m => m.to === agentName && m.deliverySessionId === sessionId && m.status !== 'acked');

    return pending.sort((a, b) => {
      const seqA = mSeq(a);
      const seqB = mSeq(b);
      return seqA === seqB ? a.ts - b.ts : seqA - seqB;
    }).map(m => ({ ...m }));

    function mSeq(msg: StoredMessage): number {
      return msg.deliverySeq ?? 0;
    }
  }

  async getMaxSeqByStream(agentName: string, sessionId: string): Promise<Array<{ peer: string; topic?: string; maxSeq: number }>> {
    const aggregates = new Map<string, { peer: string; topic?: string; maxSeq: number }>();

    for (const msg of this.messages.values()) {
      if (this.deletedMessages.has(msg.id)) continue;
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

  async removeMessagesForAgent(agentName: string): Promise<void> {
    const toDelete: string[] = [];
    for (const msg of this.messages.values()) {
      if (msg.from === agentName || msg.to === agentName) {
        toDelete.push(msg.id);
      }
    }

    if (toDelete.length === 0) return;

    const now = Date.now();
    for (const id of toDelete) {
      const record: DeleteRecord = { type: 'delete', id, ts: now };
      await this.appendMessageRecord(record);
      this.applyMessageRecord(record);
    }
  }

  // ============ Session Handling ============

  async startSession(session: Omit<StoredSession, 'messageCount'>): Promise<void> {
    await this.runWithSessionLock(async () => {
      const stored: StoredSession = { ...session, messageCount: 0 };
      const record: SessionRecord = { type: 'session-start', session: stored };
      await this.appendSessionRecord(record);
      this.applySessionRecord(record);
    });
  }

  async endSession(
    sessionId: string,
    options?: { summary?: string; closedBy?: 'agent' | 'disconnect' | 'error' }
  ): Promise<void> {
    await this.runWithSessionLock(async () => {
      const record: SessionRecord = {
        type: 'session-end',
        id: sessionId,
        endedAt: Date.now(),
        summary: options?.summary,
        closedBy: options?.closedBy,
      };
      await this.appendSessionRecord(record);
      this.applySessionRecord(record);
    });
  }

  async incrementSessionMessageCount(sessionId: string): Promise<void> {
    await this.runWithSessionLock(async () => {
      const record: SessionRecord = { type: 'session-increment', id: sessionId, delta: 1 };
      await this.appendSessionRecord(record);
      this.applySessionRecord(record);
    });
  }

  async getSessions(query: SessionQuery = {}): Promise<StoredSession[]> {
    let sessions = Array.from(this.sessions.values());

    if (query.agentName) {
      sessions = sessions.filter(s => s.agentName === query.agentName);
    }
    if (query.projectId) {
      sessions = sessions.filter(s => s.projectId === query.projectId);
    }
    if (query.since) {
      sessions = sessions.filter(s => s.startedAt >= query.since!);
    }

    sessions.sort((a, b) => b.startedAt - a.startedAt);
    const limit = query.limit ?? 50;
    return sessions.slice(0, limit).map(s => ({ ...s }));
  }

  async getRecentSessions(limit: number = 10): Promise<StoredSession[]> {
    return this.getSessions({ limit });
  }

  async getSessionByResumeToken(resumeToken: string): Promise<StoredSession | null> {
    const sessionId = this.resumeIndex.get(resumeToken);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  async removeAgent(agentName: string): Promise<void> {
    await this.runWithSessionLock(async () => {
      const updatedSessions: string[] = [];
      for (const [id, session] of this.sessions) {
        if (session.agentName === agentName) {
          this.sessions.delete(id);
          updatedSessions.push(id);
        }
      }

      if (updatedSessions.length === 0) return;

      // Rebuild resume index after removals
      this.rebuildResumeIndex();

      // Rewrite sessions file to reflect removals (sessions are small)
      await this.rewriteSessionsFile();
    });
  }

  // ============ Cleanup ============

  async cleanupExpiredMessages(): Promise<number> {
    const cutoffTs = Date.now() - this.retentionMs;
    let removedFiles = 0;

    // Remove old message files by date prefix
    try {
      const files = await fs.promises.readdir(this.messageDir);
      for (const file of files) {
        const match = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!match) continue;
        const fileDate = new Date(`${match[1]}T00:00:00Z`).getTime();
        const cutoffDay = this.startOfDay(cutoffTs);
        // Coarse day-level cleanup: may drop messages slightly newer than retention within same day bucket
        if (fileDate < cutoffDay) {
          await fs.promises.unlink(path.join(this.messageDir, file)).catch(() => {});
          removedFiles++;
        }
      }
    } catch {
      // Ignore cleanup errors; best-effort
    }

    // Remove in-memory messages older than retention and persist deletion events
    const expiredIds: string[] = [];
    for (const msg of this.messages.values()) {
      if (msg.ts < cutoffTs) {
        expiredIds.push(msg.id);
      }
    }

    if (expiredIds.length > 0) {
      const now = Date.now();
      for (const id of expiredIds) {
        const record: DeleteRecord = { type: 'delete', id, ts: now };
        await this.appendMessageRecord(record);
        this.applyMessageRecord(record);
      }
    }

    return expiredIds.length + removedFiles;
  }

  // ============ Internal Helpers ============

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredMessages().catch(() => {});
    }, this.cleanupIntervalMs);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private startFileWatching(): void {
    // Watch message directory for changes
    try {
      this.messageWatcher = fs.watch(this.messageDir, (eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          this.debouncedReloadMessages();
        }
      });

      if (this.messageWatcher.unref) {
        this.messageWatcher.unref();
      }
    } catch {
      // Directory may not exist yet or watching not supported
    }

    // Watch session file for changes
    try {
      this.sessionWatcher = fs.watch(this.sessionFile, () => {
        this.debouncedReloadSessions();
      });

      if (this.sessionWatcher.unref) {
        this.sessionWatcher.unref();
      }
    } catch {
      // File may not exist yet or watching not supported
    }
  }

  private stopFileWatching(): void {
    if (this.messageWatcher) {
      this.messageWatcher.close();
      this.messageWatcher = undefined;
    }
    if (this.sessionWatcher) {
      this.sessionWatcher.close();
      this.sessionWatcher = undefined;
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = undefined;
    }
    if (this.sessionReloadDebounceTimer) {
      clearTimeout(this.sessionReloadDebounceTimer);
      this.sessionReloadDebounceTimer = undefined;
    }
  }

  private debouncedReloadMessages(): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }
    this.reloadDebounceTimer = setTimeout(() => {
      this.loadMessagesFromDisk().catch(() => {});
    }, this.watchDebounceMs);
  }

  private debouncedReloadSessions(): void {
    if (this.sessionReloadDebounceTimer) {
      clearTimeout(this.sessionReloadDebounceTimer);
    }
    this.sessionReloadDebounceTimer = setTimeout(() => {
      this.loadSessionsFromDisk().catch(() => {});
    }, this.watchDebounceMs);
  }

  private async loadMessagesFromDisk(): Promise<void> {
    this.messages.clear();
    this.deletedMessages.clear();

    const files = await fs.promises.readdir(this.messageDir).catch(() => [] as string[]);
    const jsonFiles = files.filter(f => f.endsWith('.jsonl')).sort();

    for (const file of jsonFiles) {
      const fullPath = path.join(this.messageDir, file);
      const content = await fs.promises.readFile(fullPath, 'utf-8').catch(() => '');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed);
          this.applyMessageRecord(record as MessageLogRecord | StoredMessage);
        } catch {
          // Skip malformed lines
        }
      }
    }
  }

  private async loadSessionsFromDisk(): Promise<void> {
    this.sessions.clear();
    this.resumeIndex.clear();

    if (!fs.existsSync(this.sessionFile)) {
      return;
    }

    const content = await fs.promises.readFile(this.sessionFile, 'utf-8').catch(() => '');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as SessionRecord;
        this.applySessionRecord(record);
      } catch {
        // Skip malformed session lines
      }
    }
  }

  private applyMessageRecord(record: MessageLogRecord | StoredMessage): void {
    if ((record as MessageLogRecord).type === 'status') {
      const statusRecord = record as StatusRecord;
      const msg = this.messages.get(statusRecord.id);
      if (msg) {
        msg.status = statusRecord.status;
      }
      return;
    }

    if ((record as MessageLogRecord).type === 'delete') {
      const deleteRecord = record as DeleteRecord;
      this.deletedMessages.add(deleteRecord.id);
      this.messages.delete(deleteRecord.id);
      return;
    }

    const msgRecord = (record as MessageLogRecord).type === 'message'
      ? (record as MessageRecord).message
      : (record as StoredMessage);

    // Normalize message (upsert semantics)
    const normalized: StoredMessage = {
      ...msgRecord,
      topic: msgRecord.topic ?? undefined,
      thread: msgRecord.thread ?? undefined,
      deliverySeq: msgRecord.deliverySeq ?? undefined,
      deliverySessionId: msgRecord.deliverySessionId ?? undefined,
      sessionId: msgRecord.sessionId ?? undefined,
      data: msgRecord.data ?? undefined,
      payloadMeta: msgRecord.payloadMeta ?? undefined,
      is_broadcast: msgRecord.is_broadcast ?? false,
      is_urgent: msgRecord.is_urgent ?? false,
    };

    this.messages.set(normalized.id, normalized);
    this.deletedMessages.delete(normalized.id);
  }

  private applySessionRecord(record: SessionRecord): void {
    switch (record.type) {
      case 'session-start': {
        const incoming = record.session;
        const existing = this.sessions.get(incoming.id);

        const merged: StoredSession = {
          id: incoming.id,
          agentName: incoming.agentName,
          cli: incoming.cli ?? existing?.cli,
          projectId: incoming.projectId ?? existing?.projectId,
          projectRoot: incoming.projectRoot ?? existing?.projectRoot,
          startedAt: existing?.startedAt ?? incoming.startedAt,
          endedAt: incoming.endedAt ?? existing?.endedAt,
          messageCount: existing?.messageCount ?? incoming.messageCount ?? 0,
          summary: incoming.summary ?? existing?.summary,
          resumeToken: incoming.resumeToken ?? existing?.resumeToken,
          closedBy: incoming.closedBy ?? existing?.closedBy,
        };

        this.sessions.set(incoming.id, merged);
        if (merged.resumeToken) {
          this.resumeIndex.set(merged.resumeToken, incoming.id);
        }
        break;
      }

      case 'session-end': {
        const existing = this.sessions.get(record.id);
        if (!existing) return;

        existing.endedAt = record.endedAt;
        existing.summary = record.summary ?? existing.summary;
        existing.closedBy = record.closedBy ?? existing.closedBy;
        break;
      }

      case 'session-increment': {
        const existing = this.sessions.get(record.id);
        if (existing) {
          existing.messageCount += record.delta;
        }
        break;
      }
    }
  }

  private async appendMessageRecord(record: MessageLogRecord): Promise<void> {
    const targetFile = this.getMessageFilePath(record.type === 'message' ? record.message.ts : Date.now());
    const line = `${JSON.stringify(record)}\n`;
    await this.enqueueMessageWrite(async () => {
      await fs.promises.appendFile(targetFile, line, 'utf-8');
    });
  }

  private async appendSessionRecord(record: SessionRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    await fs.promises.appendFile(this.sessionFile, line, 'utf-8');
  }

  private getMessageFilePath(ts: number): string {
    const date = new Date(ts);
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    return path.join(this.messageDir, `${dateStr}.jsonl`);
  }

  private computeReplyCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const msg of this.messages.values()) {
      if (this.deletedMessages.has(msg.id)) continue;
      if (msg.thread) {
        counts.set(msg.thread, (counts.get(msg.thread) ?? 0) + 1);
      }
    }
    return counts;
  }

  private startOfDay(ts: number): number {
    const d = new Date(ts);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  private rebuildResumeIndex(): void {
    this.resumeIndex.clear();
    for (const [id, session] of this.sessions) {
      if (session.resumeToken) {
        this.resumeIndex.set(session.resumeToken, id);
      }
    }
  }

  private async rewriteSessionsFile(): Promise<void> {
    const records: SessionRecord[] = [];
    for (const session of this.sessions.values()) {
      records.push({ type: 'session-start', session });
      if (session.endedAt !== undefined) {
        records.push({ type: 'session-end', id: session.id, endedAt: session.endedAt, summary: session.summary, closedBy: session.closedBy });
      }
    }

    const content = records.map(r => JSON.stringify(r)).join('\n');
    const tmpPath = `${this.sessionFile}.tmp`;

    await fs.promises.writeFile(tmpPath, content ? `${content}\n` : '', 'utf-8');
    await fs.promises.rename(tmpPath, this.sessionFile);
  }

  /**
   * Serialize session operations to prevent races between append/rewrite paths.
   */
  private async runWithSessionLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sessionLock.then(fn);
    this.sessionLock = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Serialize message writes; keep chain alive even if a single write fails.
   */
  private async enqueueMessageWrite(fn: () => Promise<void>): Promise<void> {
    const run = this.messageWriteChain.then(fn);
    this.messageWriteChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
