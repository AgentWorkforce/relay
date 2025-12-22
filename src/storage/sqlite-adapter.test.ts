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
});
