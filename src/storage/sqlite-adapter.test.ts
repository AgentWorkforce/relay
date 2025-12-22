import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStorageAdapter } from './sqlite-adapter.js';
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
  thread: overrides.thread,
  deliverySeq: overrides.deliverySeq,
  deliverySessionId: overrides.deliverySessionId,
  sessionId: overrides.sessionId,
  status: overrides.status ?? 'unread',
  is_urgent: overrides.is_urgent ?? false,
});

describe('SqliteStorageAdapter', () => {
  let dbPath: string;
  let adapter: SqliteStorageAdapter;
  const originalDriver = process.env.AGENT_RELAY_SQLITE_DRIVER;

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sqlite-'));
    dbPath = path.join(tmpDir, 'messages.sqlite');
    adapter = new SqliteStorageAdapter({ dbPath });
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
});
