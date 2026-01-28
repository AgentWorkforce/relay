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
});
