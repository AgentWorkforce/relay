import { describe, it, expect } from 'vitest';
import { MemoryStorageAdapter } from './adapter.js';

describe('MemoryStorageAdapter', () => {
  it('applies unreadOnly and urgentOnly filters', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.init();

    await adapter.saveMessage({
      id: 'm1',
      ts: Date.now() - 1000,
      from: 'A',
      to: 'B',
      kind: 'message',
      body: 'old',
      status: 'read',
      is_urgent: false,
    });
    await adapter.saveMessage({
      id: 'm2',
      ts: Date.now(),
      from: 'A',
      to: 'B',
      kind: 'message',
      body: 'urgent',
      status: 'unread',
      is_urgent: true,
    });

    const unread = await adapter.getMessages({ unreadOnly: true });
    expect(unread.map(m => m.id)).toEqual(['m2']);

    const urgent = await adapter.getMessages({ urgentOnly: true });
    expect(urgent.map(m => m.id)).toEqual(['m2']);
  });

  it('supports bidirectional DM queries when bidirectional is enabled', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.init();

    const now = Date.now();
    await adapter.saveMessage({
      id: 'dm-1',
      ts: now - 3000,
      from: 'Alice',
      to: 'Bob',
      kind: 'message',
      body: 'a->b',
      status: 'unread',
      is_urgent: false,
    });
    await adapter.saveMessage({
      id: 'dm-2',
      ts: now - 2000,
      from: 'Bob',
      to: 'Alice',
      kind: 'message',
      body: 'b->a',
      status: 'unread',
      is_urgent: false,
    });
    await adapter.saveMessage({
      id: 'dm-3',
      ts: now - 1000,
      from: 'Alice',
      to: 'Charlie',
      kind: 'message',
      body: 'a->c',
      status: 'unread',
      is_urgent: false,
    });

    const oneWay = await adapter.getMessages({ from: 'Alice', to: 'Bob', order: 'asc' });
    expect(oneWay.map(m => m.id)).toEqual(['dm-1']);

    const ascending = await adapter.getMessages({
      from: 'Alice',
      to: 'Bob',
      bidirectional: true,
      order: 'asc',
    });
    expect(ascending.map(m => m.id)).toEqual(['dm-1', 'dm-2']);

    const descending = await adapter.getMessages({
      from: 'Alice',
      to: 'Bob',
      bidirectional: true,
      order: 'desc',
    });
    expect(descending.map(m => m.id)).toEqual(['dm-2', 'dm-1']);
  });
});
