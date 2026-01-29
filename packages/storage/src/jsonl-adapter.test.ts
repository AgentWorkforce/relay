import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlStorageAdapter } from './jsonl-adapter.js';
import type { StoredMessage } from './adapter.js';

const makeMessage = (overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  id: overrides.id ?? `msg-${Math.random().toString(16).slice(2, 10)}`,
  ts: overrides.ts ?? Date.now(),
  from: overrides.from ?? 'A',
  to: overrides.to ?? 'B',
  topic: overrides.topic,
  kind: overrides.kind ?? 'message',
  body: overrides.body ?? 'hi',
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

describe('JsonlStorageAdapter', () => {
  let baseDir: string;
  let adapter: JsonlStorageAdapter;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-jsonl-'));
    adapter = new JsonlStorageAdapter({ baseDir, cleanupIntervalMs: 0 });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('persists messages across restarts', async () => {
    const msg = makeMessage({ id: 'persist-1', body: 'hello' });
    await adapter.saveMessage(msg);

    // Recreate adapter to simulate restart
    await adapter.close();
    adapter = new JsonlStorageAdapter({ baseDir, cleanupIntervalMs: 0 });
    await adapter.init();

    const messages = await adapter.getMessages({});
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('persist-1');
    expect(messages[0].body).toBe('hello');
  });

  it('supports filters, status updates, and reply counts', async () => {
    const now = Date.now();
    await adapter.saveMessage(makeMessage({ id: 'a', ts: now - 100, from: 'A', to: 'B', topic: 't' }));
    await adapter.saveMessage(makeMessage({ id: 'b', ts: now, from: 'B', to: 'A', thread: 'a', topic: 't' }));

    await adapter.updateMessageStatus('a', 'read');
    const filtered = await adapter.getMessages({ from: 'A', topic: 't' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].status).toBe('read');
    expect(filtered[0].replyCount).toBe(1);
  });

  it('supports pending delivery helpers', async () => {
    const sessionId = 'sess-1';
    await adapter.saveMessage(makeMessage({
      id: 'm1',
      to: 'Bob',
      from: 'Alice',
      deliverySeq: 2,
      deliverySessionId: sessionId,
      sessionId,
      status: 'unread',
    }));
    await adapter.saveMessage(makeMessage({
      id: 'm2',
      to: 'Bob',
      from: 'Alice',
      deliverySeq: 1,
      deliverySessionId: sessionId,
      sessionId,
      status: 'acked',
    }));

    const pending = await adapter.getPendingMessagesForSession('Bob', sessionId);
    expect(pending.map(p => p.id)).toEqual(['m1']);

    const seqs = await adapter.getMaxSeqByStream('Bob', sessionId);
    expect(seqs).toEqual([{ peer: 'Alice', topic: undefined, maxSeq: 2 }]);
  });

  it('increments and resumes sessions', async () => {
    const startedAt = Date.now() - 1000;
    await adapter.startSession({
      id: 's1',
      agentName: 'Agent1',
      startedAt,
      resumeToken: 'token-1',
    });
    await adapter.incrementSessionMessageCount('s1');
    await adapter.endSession('s1', { summary: 'done', closedBy: 'agent' });

    // Restart and ensure sessions reload
    await adapter.close();
    adapter = new JsonlStorageAdapter({ baseDir, cleanupIntervalMs: 0 });
    await adapter.init();

    const sessions = await adapter.getSessions({});
    expect(sessions[0]).toMatchObject({
      id: 's1',
      agentName: 'Agent1',
      summary: 'done',
      closedBy: 'agent',
      messageCount: 1,
    });

    const byToken = await adapter.getSessionByResumeToken('token-1');
    expect(byToken?.id).toBe('s1');
  });

  it('cleans up expired messages based on retention', async () => {
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await adapter.saveMessage(makeMessage({ id: 'old', ts: oldTs }));
    await adapter.saveMessage(makeMessage({ id: 'new', ts: Date.now() }));

    const deleted = await adapter.cleanupExpiredMessages();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await adapter.getMessages({});
    expect(remaining.some(m => m.id === 'old')).toBe(false);
  });

  it('removes messages for a specific agent', async () => {
    await adapter.saveMessage(makeMessage({ id: 'x1', from: 'Target', to: 'Other' }));
    await adapter.saveMessage(makeMessage({ id: 'x2', from: 'Other', to: 'Target' }));
    await adapter.saveMessage(makeMessage({ id: 'x3', from: 'Other', to: 'Other2' }));

    await adapter.removeMessagesForAgent('Target');
    const messages = await adapter.getMessages({});
    expect(messages.map(m => m.id).sort()).toEqual(['x3']);
  });

  it('handles concurrent writes', async () => {
    const toWrite = Array.from({ length: 25 }).map((_, i) => makeMessage({ id: `c-${i}` }));
    await Promise.all(toWrite.map(m => adapter.saveMessage(m)));

    const messages = await adapter.getMessages({});
    expect(messages).toHaveLength(25);

    // Ensure file is parseable and not interleaved
    const files = fs.readdirSync(path.join(baseDir, 'messages'));
    const content = fs.readFileSync(path.join(baseDir, 'messages', files[0]), 'utf-8');
    const parsed = content.split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(parsed).toHaveLength(25);
  });

  it('health check reports readable/writable', async () => {
    const health = await adapter.healthCheck();
    expect(health.persistent).toBe(true);
    expect(health.driver).toBe('jsonl');
    expect(health.canRead).toBe(true);
    expect(health.canWrite).toBe(true);
  });

  it('serializes session mutations to avoid lost increments', async () => {
    await adapter.startSession({
      id: 'sess-lock',
      agentName: 'Agent',
      startedAt: Date.now(),
    });

    await Promise.all(Array.from({ length: 20 }).map(() => adapter.incrementSessionMessageCount('sess-lock')));
    const sessions = await adapter.getSessions({});
    expect(sessions[0]?.messageCount).toBe(20);
  });

  it('does not double messageCount when sessions file is rewritten', async () => {
    await adapter.startSession({
      id: 'sess-rewrite',
      agentName: 'Agent',
      startedAt: Date.now(),
    });
    await adapter.incrementSessionMessageCount('sess-rewrite');
    await adapter.incrementSessionMessageCount('sess-rewrite');

    // Force a sessions rewrite and reload
    await (adapter as any).rewriteSessionsFile();
    await adapter.close();
    adapter = new JsonlStorageAdapter({ baseDir, cleanupIntervalMs: 0 });
    await adapter.init();

    const sessions = await adapter.getSessions({ agentName: 'Agent' });
    expect(sessions[0]?.messageCount).toBe(2);
  });

  it('auto-reloads messages when watchForChanges is enabled', async () => {
    // Create a watching adapter
    const watchingAdapter = new JsonlStorageAdapter({
      baseDir,
      cleanupIntervalMs: 0,
      watchForChanges: true,
      watchDebounceMs: 50,
    });
    await watchingAdapter.init();

    // Initially no messages (adapter doesn't share with the default one)
    const before = await watchingAdapter.getMessages({});
    const countBefore = before.length;

    // Write a message directly to disk using another adapter (simulating daemon)
    const writerAdapter = new JsonlStorageAdapter({ baseDir, cleanupIntervalMs: 0 });
    await writerAdapter.init();
    await writerAdapter.saveMessage(makeMessage({ id: 'watch-test', body: 'from daemon' }));
    await writerAdapter.close();

    // Wait for debounce + file watcher to trigger reload
    await new Promise(resolve => setTimeout(resolve, 200));

    // Should now see the new message
    const after = await watchingAdapter.getMessages({});
    expect(after.length).toBe(countBefore + 1);
    expect(after.some(m => m.id === 'watch-test')).toBe(true);

    await watchingAdapter.close();
  });
});
