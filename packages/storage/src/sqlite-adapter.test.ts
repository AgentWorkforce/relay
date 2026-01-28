import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorageAdapter } from './sqlite-adapter.js';
import { MemoryStorageAdapter } from './adapter.js';
import type { StoredMessage } from './adapter.js';

const makeMessage = (overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  id: overrides.id ?? 'msg-1',
  ts: overrides.ts ?? Date.now(),
  from: overrides.from ?? 'AgentA',
  to: overrides.to ?? 'AgentB',
  topic: overrides.topic,
  kind: overrides.kind ?? 'message',
  body: overrides.body ?? 'hello',
  data: overrides.data,
  payloadMeta: overrides.payloadMeta,
  thread: overrides.thread,
  deliverySeq: overrides.deliverySeq,
  deliverySessionId: overrides.deliverySessionId,
  sessionId: overrides.sessionId,
  status: overrides.status ?? 'unread',
  is_urgent: overrides.is_urgent ?? false,
  is_broadcast: overrides.is_broadcast ?? false,
});

describe('SqliteStorageAdapter', () => {
  let dbPath: string;
  let adapter: SqliteStorageAdapter;
  const originalDriver = process.env.AGENT_RELAY_SQLITE_DRIVER;

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sqlite-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    adapter = new SqliteStorageAdapter({ dbPath, cleanupIntervalMs: 0 }); // Disable auto cleanup for tests
    await adapter.init();
  });

  afterEach(async () => {
    if (originalDriver === undefined) {
      delete process.env.AGENT_RELAY_SQLITE_DRIVER;
    } else {
      process.env.AGENT_RELAY_SQLITE_DRIVER = originalDriver;
    }
    await adapter.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('saves and retrieves messages', async () => {
    const msg = makeMessage({ id: 'abc', topic: 't1', body: 'hi' });
    await adapter.saveMessage(msg);

    const rows = await adapter.getMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'abc',
      from: 'AgentA',
      to: 'AgentB',
      topic: 't1',
      body: 'hi',
    });
  });

  it('applies filters and ordering', async () => {
    const now = Date.now();
    await adapter.saveMessage(makeMessage({ id: 'm1', ts: now - 2000, from: 'A', to: 'B', topic: 'x' }));
    await adapter.saveMessage(makeMessage({ id: 'm2', ts: now - 1000, from: 'A', to: 'C', topic: 'y' }));
    await adapter.saveMessage(makeMessage({ id: 'm3', ts: now, from: 'B', to: 'A', topic: 'x' }));

    const filtered = await adapter.getMessages({ from: 'A', order: 'asc' });
    expect(filtered.map(r => r.id)).toEqual(['m1', 'm2']);

    const since = await adapter.getMessages({ sinceTs: now - 1500, order: 'asc' });
    expect(since.map(r => r.id)).toEqual(['m2', 'm3']);

    const limited = await adapter.getMessages({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('supports unread and urgent filters', async () => {
    const now = Date.now();
    await adapter.saveMessage(makeMessage({ id: 'u1', ts: now - 3000, status: 'unread', is_urgent: false }));
    await adapter.saveMessage(makeMessage({ id: 'u2', ts: now - 2000, status: 'unread', is_urgent: true }));
    await adapter.saveMessage(makeMessage({ id: 'u3', ts: now - 1000, status: 'read', is_urgent: true }));
    await adapter.saveMessage(makeMessage({ id: 'u4', ts: now, status: 'read', is_urgent: false }));

    const unread = await adapter.getMessages({ unreadOnly: true, order: 'asc' });
    expect(unread.map(r => r.id)).toEqual(['u1', 'u2']);

    const urgent = await adapter.getMessages({ urgentOnly: true, order: 'asc' });
    expect(urgent.map(r => r.id)).toEqual(['u2', 'u3']);

    const unreadUrgent = await adapter.getMessages({ unreadOnly: true, urgentOnly: true, order: 'asc' });
    expect(unreadUrgent.map(r => r.id)).toEqual(['u2']);
  });

  it('supports thread filtering', async () => {
    await adapter.saveMessage(makeMessage({ id: 't1', thread: 'th-1', body: 'a' }));
    await adapter.saveMessage(makeMessage({ id: 't2', thread: 'th-2', body: 'b' }));
    await adapter.saveMessage(makeMessage({ id: 't3', body: 'c' }));

    const rows = await adapter.getMessages({ thread: 'th-1', order: 'asc' });
    expect(rows.map(r => r.id)).toEqual(['t1']);
  });

  it('can force node sqlite driver', async () => {
    await adapter.close();
    process.env.AGENT_RELAY_SQLITE_DRIVER = 'node';
    adapter = new SqliteStorageAdapter({ dbPath });
    await adapter.init();

    await adapter.saveMessage(makeMessage({ id: 'node-1', body: 'hi' }));
    const rows = await adapter.getMessages();
    expect(rows.map(r => r.id)).toEqual(['node-1']);
  });

  it('prefers better-sqlite3 but falls back when unavailable', async () => {
    await adapter.close();
    process.env.AGENT_RELAY_SQLITE_DRIVER = 'better-sqlite3';
    adapter = new SqliteStorageAdapter({ dbPath });
    await adapter.init();

    await adapter.saveMessage(makeMessage({ id: 'fallback-1', body: 'ok' }));
    const rows = await adapter.getMessages();
    expect(rows.map(r => r.id)).toEqual(['fallback-1']);
  });

  it('reports healthy persistent storage via healthCheck', async () => {
    const health = await adapter.healthCheck();
    expect(health.persistent).toBe(true);
    expect(health.driver).toBe('sqlite');
    expect(health.canRead).toBe(true);
    expect(health.canWrite).toBe(true);
    expect(health.error).toBeUndefined();
  });

  it('reports memory storage health and reason', async () => {
    const mem = new MemoryStorageAdapter({ reason: 'fallback' });
    await mem.init();
    const health = await mem.healthCheck();
    expect(health.persistent).toBe(false);
    expect(health.driver).toBe('memory');
    expect(health.canRead).toBe(true);
    expect(health.canWrite).toBe(true);
    expect(health.error).toContain('fallback');
  });

  describe('Session Management', () => {
    it('starts and retrieves a session', async () => {
      const sessionId = 'session-1';
      await adapter.startSession({
        id: sessionId,
        agentName: 'TestAgent',
        cli: 'claude',
        projectId: 'proj-123',
        projectRoot: '/home/test/project',
        startedAt: Date.now(),
      });

      const sessions = await adapter.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: sessionId,
        agentName: 'TestAgent',
        cli: 'claude',
        projectId: 'proj-123',
        messageCount: 0,
      });
      expect(sessions[0].endedAt).toBeUndefined();
    });

    it('ends a session with closedBy reason', async () => {
      const sessionId = 'session-2';
      await adapter.startSession({
        id: sessionId,
        agentName: 'Agent2',
        startedAt: Date.now() - 5000,
      });

      await adapter.endSession(sessionId, {
        summary: 'Completed auth module',
        closedBy: 'agent',
      });

      const sessions = await adapter.getSessions();
      expect(sessions[0]).toMatchObject({
        id: sessionId,
        summary: 'Completed auth module',
        closedBy: 'agent',
      });
      expect(sessions[0].endedAt).toBeDefined();
    });

    it('increments session message count', async () => {
      const sessionId = 'session-3';
      await adapter.startSession({
        id: sessionId,
        agentName: 'Agent3',
        startedAt: Date.now(),
      });

      await adapter.incrementSessionMessageCount(sessionId);
      await adapter.incrementSessionMessageCount(sessionId);
      await adapter.incrementSessionMessageCount(sessionId);

      const sessions = await adapter.getSessions();
      expect(sessions[0].messageCount).toBe(3);
    });

    it('stores and retrieves a resume token', async () => {
      const token = 'resume-123';
      await adapter.startSession({
        id: 'resume-session',
        agentName: 'ResumeAgent',
        startedAt: Date.now(),
        resumeToken: token,
      });

      const session = await adapter.getSessionByResumeToken(token);
      expect(session).not.toBeNull();
      expect(session?.id).toBe('resume-session');
      expect(session?.resumeToken).toBe(token);
    });

    it('filters sessions by agentName and projectId', async () => {
      const now = Date.now();
      await adapter.startSession({ id: 's1', agentName: 'Alice', projectId: 'p1', startedAt: now - 2000 });
      await adapter.startSession({ id: 's2', agentName: 'Bob', projectId: 'p1', startedAt: now - 1000 });
      await adapter.startSession({ id: 's3', agentName: 'Alice', projectId: 'p2', startedAt: now });

      const aliceSessions = await adapter.getSessions({ agentName: 'Alice' });
      expect(aliceSessions.map(s => s.id)).toEqual(['s3', 's1']);

      const p1Sessions = await adapter.getSessions({ projectId: 'p1' });
      expect(p1Sessions.map(s => s.id)).toEqual(['s2', 's1']);
    });

    it('getRecentSessions returns limited results', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.startSession({
          id: `recent-${i}`,
          agentName: 'Agent',
          startedAt: Date.now() + i * 100,
        });
      }

      const recent = await adapter.getRecentSessions(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].id).toBe('recent-4'); // Most recent first
    });
  });

  describe('Resume helpers', () => {
    it('returns pending messages and max seq per stream', async () => {
      const sessionId = 'sess-1';
      await adapter.saveMessage({
        id: 'm1',
        ts: Date.now(),
        from: 'Alice',
        to: 'Bob',
        kind: 'message',
        body: 'one',
        status: 'unread',
        is_urgent: false,
        deliverySeq: 1,
        deliverySessionId: sessionId,
        sessionId,
        is_broadcast: false,
      });

      await adapter.saveMessage({
        id: 'm2',
        ts: Date.now() + 10,
        from: 'Alice',
        to: 'Bob',
        kind: 'message',
        body: 'two',
        status: 'unread',
        is_urgent: false,
        deliverySeq: 2,
        deliverySessionId: sessionId,
        sessionId,
        is_broadcast: false,
      });

      await adapter.saveMessage({
        id: 'm3',
        ts: Date.now() + 20,
        from: 'Carol',
        to: 'Bob',
        kind: 'message',
        body: 'three',
        status: 'unread',
        is_urgent: false,
        deliverySeq: 1,
        deliverySessionId: sessionId,
        sessionId,
        is_broadcast: false,
      });

      await adapter.updateMessageStatus?.('m2', 'acked');

      const pending = await adapter.getPendingMessagesForSession?.('Bob', sessionId);
      expect(pending?.map(p => p.id)).toEqual(['m1', 'm3']);

      const seqs = await adapter.getMaxSeqByStream?.('Bob', sessionId);
      const sorted = (seqs ?? []).sort((a, b) => a.peer.localeCompare(b.peer));
      expect(sorted).toEqual([
        { peer: 'Alice', topic: undefined, maxSeq: 2 },
        { peer: 'Carol', topic: undefined, maxSeq: 1 },
      ]);
    });
  });

  describe('Agent Summaries', () => {
    it('saves and retrieves an agent summary', async () => {
      await adapter.saveAgentSummary({
        agentName: 'SummaryAgent',
        projectId: 'proj-1',
        currentTask: 'Implementing auth',
        completedTasks: ['setup', 'database'],
        decisions: ['Use JWT'],
        context: 'Working on login flow',
        files: ['src/auth.ts', 'src/login.ts'],
      });

      const summary = await adapter.getAgentSummary('SummaryAgent');
      expect(summary).not.toBeNull();
      expect(summary).toMatchObject({
        agentName: 'SummaryAgent',
        projectId: 'proj-1',
        currentTask: 'Implementing auth',
        completedTasks: ['setup', 'database'],
        decisions: ['Use JWT'],
        context: 'Working on login flow',
        files: ['src/auth.ts', 'src/login.ts'],
      });
      expect(summary!.lastUpdated).toBeDefined();
    });

    it('returns null for non-existent agent summary', async () => {
      const summary = await adapter.getAgentSummary('NonExistent');
      expect(summary).toBeNull();
    });

    it('updates existing summary on save', async () => {
      await adapter.saveAgentSummary({
        agentName: 'UpdateAgent',
        currentTask: 'Task 1',
      });

      await adapter.saveAgentSummary({
        agentName: 'UpdateAgent',
        currentTask: 'Task 2',
        completedTasks: ['Task 1'],
      });

      const summary = await adapter.getAgentSummary('UpdateAgent');
      expect(summary?.currentTask).toBe('Task 2');
      expect(summary?.completedTasks).toEqual(['Task 1']);
    });

    it('getAllAgentSummaries returns all summaries ordered by lastUpdated', async () => {
      await adapter.saveAgentSummary({ agentName: 'Agent1', currentTask: 'T1' });
      await new Promise(r => setTimeout(r, 10)); // Small delay for different timestamps
      await adapter.saveAgentSummary({ agentName: 'Agent2', currentTask: 'T2' });
      await new Promise(r => setTimeout(r, 10));
      await adapter.saveAgentSummary({ agentName: 'Agent3', currentTask: 'T3' });

      const summaries = await adapter.getAllAgentSummaries();
      expect(summaries).toHaveLength(3);
      expect(summaries[0].agentName).toBe('Agent3'); // Most recent first
      expect(summaries[2].agentName).toBe('Agent1'); // Oldest last
    });
  });

  describe('getMessageById', () => {
    it('retrieves message by exact ID', async () => {
      await adapter.saveMessage(makeMessage({ id: 'exact-id-123', body: 'hello' }));

      const msg = await adapter.getMessageById('exact-id-123');
      expect(msg).not.toBeNull();
      expect(msg?.body).toBe('hello');
    });

    it('retrieves message by ID prefix', async () => {
      await adapter.saveMessage(makeMessage({ id: 'prefix-abc-xyz-123', body: 'world' }));

      const msg = await adapter.getMessageById('prefix-abc');
      expect(msg).not.toBeNull();
      expect(msg?.id).toBe('prefix-abc-xyz-123');
    });

    it('returns null for non-existent message', async () => {
      const msg = await adapter.getMessageById('does-not-exist');
      expect(msg).toBeNull();
    });
  });

  describe('message cleanup', () => {
    it('cleanupExpiredMessages removes old messages', async () => {
      const now = Date.now();
      const oldTs = now - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      const newTs = now - 1 * 24 * 60 * 60 * 1000; // 1 day ago

      // Save old and new messages
      await adapter.saveMessage(makeMessage({ id: 'old-msg', ts: oldTs }));
      await adapter.saveMessage(makeMessage({ id: 'new-msg', ts: newTs }));

      // Verify both exist
      let messages = await adapter.getMessages({});
      expect(messages).toHaveLength(2);

      // Run cleanup (default 7 day retention)
      const deleted = await adapter.cleanupExpiredMessages();
      expect(deleted).toBe(1);

      // Verify only new message remains
      messages = await adapter.getMessages({});
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('new-msg');
    });

    it('cleanupExpiredMessages returns 0 when no expired messages', async () => {
      await adapter.saveMessage(makeMessage({ id: 'recent-msg', ts: Date.now() }));

      const deleted = await adapter.cleanupExpiredMessages();
      expect(deleted).toBe(0);

      const messages = await adapter.getMessages({});
      expect(messages).toHaveLength(1);
    });

    it('respects custom retention period', async () => {
      // Close current adapter and create one with shorter retention
      await adapter.close();

      const shortRetentionAdapter = new SqliteStorageAdapter({
        dbPath,
        messageRetentionMs: 1000, // 1 second
        cleanupIntervalMs: 0, // Disable auto cleanup
      });
      await shortRetentionAdapter.init();

      const oldTs = Date.now() - 2000; // 2 seconds ago
      await shortRetentionAdapter.saveMessage(makeMessage({ id: 'msg', ts: oldTs }));

      const deleted = await shortRetentionAdapter.cleanupExpiredMessages();
      expect(deleted).toBe(1);

      await shortRetentionAdapter.close();
    });
  });

  describe('getStats', () => {
    it('returns correct counts', async () => {
      await adapter.saveMessage(makeMessage({ id: 'msg-1' }));
      await adapter.saveMessage(makeMessage({ id: 'msg-2' }));

      const stats = await adapter.getStats();
      expect(stats.messageCount).toBe(2);
      expect(stats.sessionCount).toBe(0);
      expect(stats.oldestMessageTs).toBeDefined();
    });

    it('returns undefined oldestMessageTs when no messages', async () => {
      const stats = await adapter.getStats();
      expect(stats.messageCount).toBe(0);
      expect(stats.oldestMessageTs).toBeUndefined();
    });
  });

  describe('removeAgent', () => {
    it('removes agent from sessions table', async () => {
      // Create a session via startSession
      await adapter.startSession({
        id: 'session-1',
        agentName: 'TestAgent',
        startedAt: new Date().toISOString(),
      });

      // Verify session exists
      let sessions = await adapter.getSessions({});
      expect(sessions.some(s => s.agentName === 'TestAgent')).toBe(true);

      // Remove the agent
      await adapter.removeAgent('TestAgent');

      // Verify session is gone
      sessions = await adapter.getSessions({});
      expect(sessions.some(s => s.agentName === 'TestAgent')).toBe(false);
    });

    it('does not throw when removing non-existent agent', async () => {
      await expect(adapter.removeAgent('NonExistent')).resolves.not.toThrow();
    });

    it('only removes specified agent, not others', async () => {
      await adapter.startSession({
        id: 'session-1',
        agentName: 'Agent1',
        startedAt: new Date().toISOString(),
      });
      await adapter.startSession({
        id: 'session-2',
        agentName: 'Agent2',
        startedAt: new Date().toISOString(),
      });

      await adapter.removeAgent('Agent1');

      const sessions = await adapter.getSessions({});
      expect(sessions.some(s => s.agentName === 'Agent1')).toBe(false);
      expect(sessions.some(s => s.agentName === 'Agent2')).toBe(true);
    });
  });

  describe('removeMessagesForAgent', () => {
    it('removes messages sent by agent', async () => {
      await adapter.saveMessage(makeMessage({ id: 'msg-1', from: 'TestAgent', to: 'Other' }));
      await adapter.saveMessage(makeMessage({ id: 'msg-2', from: 'Other', to: 'Someone' }));

      await adapter.removeMessagesForAgent('TestAgent');

      const messages = await adapter.getMessages({});
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-2');
    });

    it('removes messages sent to agent', async () => {
      await adapter.saveMessage(makeMessage({ id: 'msg-1', from: 'Other', to: 'TestAgent' }));
      await adapter.saveMessage(makeMessage({ id: 'msg-2', from: 'Other', to: 'Someone' }));

      await adapter.removeMessagesForAgent('TestAgent');

      const messages = await adapter.getMessages({});
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-2');
    });

    it('removes messages both from and to agent', async () => {
      await adapter.saveMessage(makeMessage({ id: 'msg-1', from: 'TestAgent', to: 'Other' }));
      await adapter.saveMessage(makeMessage({ id: 'msg-2', from: 'Other', to: 'TestAgent' }));
      await adapter.saveMessage(makeMessage({ id: 'msg-3', from: 'Other', to: 'Someone' }));

      await adapter.removeMessagesForAgent('TestAgent');

      const messages = await adapter.getMessages({});
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-3');
    });

    it('does not throw when no messages exist', async () => {
      await expect(adapter.removeMessagesForAgent('NonExistent')).resolves.not.toThrow();
    });
  });
});
