/**
 * Tests for broadcast message deduplication in #general channel
 *
 * TDD approach: Write failing tests first, then fix the implementation.
 *
 * Problem: When a broadcast is sent (to='*'), the backend delivers it to each
 * recipient separately. Each delivery gets a unique ID and is stored separately.
 * In #general channel, this causes the same message to appear multiple times
 * (once per recipient).
 *
 * Solution: Deduplicate broadcast messages by grouping those with the same
 * sender, content, and approximate timestamp (within 1 second).
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '../../types';
import { deduplicateBroadcasts, getBroadcastKey } from './useBroadcastDedup';

// Helper to create test messages
function createMessage(
  from: string,
  to: string,
  content: string,
  options?: {
    id?: string;
    isBroadcast?: boolean;
    timestamp?: string;
    channel?: string;
  }
): Message {
  return {
    id: options?.id || `msg-${Math.random().toString(36).slice(2)}`,
    from,
    to,
    content,
    timestamp: options?.timestamp || new Date().toISOString(),
    isBroadcast: options?.isBroadcast,
    channel: options?.channel,
  };
}

describe('Broadcast Deduplication', () => {
  describe('deduplicateBroadcasts', () => {
    it('should show broadcast message only once when delivered to multiple recipients', () => {
      const timestamp = '2026-01-08T12:00:00.000Z';

      // Same broadcast delivered to 3 different recipients
      const messages: Message[] = [
        createMessage('Alice', 'Agent1', 'Hello everyone!', {
          id: 'delivery-1',
          isBroadcast: true,
          timestamp,
          channel: 'general',
        }),
        createMessage('Alice', 'Agent2', 'Hello everyone!', {
          id: 'delivery-2',
          isBroadcast: true,
          timestamp,
          channel: 'general',
        }),
        createMessage('Alice', 'Agent3', 'Hello everyone!', {
          id: 'delivery-3',
          isBroadcast: true,
          timestamp,
          channel: 'general',
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      // Should only show one instance of the broadcast
      expect(deduped).toHaveLength(1);
      expect(deduped[0].content).toBe('Hello everyone!');
      expect(deduped[0].from).toBe('Alice');
    });

    it('should preserve different broadcasts from the same sender', () => {
      const timestamp1 = '2026-01-08T12:00:00.000Z';
      const timestamp2 = '2026-01-08T12:01:00.000Z'; // 1 minute later

      const messages: Message[] = [
        // First broadcast delivered to 2 recipients
        createMessage('Alice', 'Agent1', 'First message', {
          id: 'delivery-1',
          isBroadcast: true,
          timestamp: timestamp1,
          channel: 'general',
        }),
        createMessage('Alice', 'Agent2', 'First message', {
          id: 'delivery-2',
          isBroadcast: true,
          timestamp: timestamp1,
          channel: 'general',
        }),
        // Second broadcast delivered to 2 recipients
        createMessage('Alice', 'Agent1', 'Second message', {
          id: 'delivery-3',
          isBroadcast: true,
          timestamp: timestamp2,
          channel: 'general',
        }),
        createMessage('Alice', 'Agent2', 'Second message', {
          id: 'delivery-4',
          isBroadcast: true,
          timestamp: timestamp2,
          channel: 'general',
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      // Should show both broadcasts, but only once each
      expect(deduped).toHaveLength(2);
      expect(deduped.map(m => m.content)).toContain('First message');
      expect(deduped.map(m => m.content)).toContain('Second message');
    });

    it('should not deduplicate non-broadcast messages', () => {
      const timestamp = '2026-01-08T12:00:00.000Z';

      // Direct messages with same content should NOT be deduplicated
      const messages: Message[] = [
        createMessage('Alice', 'Bob', 'Hello!', {
          id: 'dm-1',
          isBroadcast: false,
          timestamp,
        }),
        createMessage('Alice', 'Charlie', 'Hello!', {
          id: 'dm-2',
          isBroadcast: false,
          timestamp,
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      // Both DMs should remain (they're intentionally separate messages)
      expect(deduped).toHaveLength(2);
    });

    it('should preserve message order after deduplication', () => {
      const messages: Message[] = [
        createMessage('Alice', 'Agent1', 'First', {
          id: 'msg-1',
          isBroadcast: true,
          timestamp: '2026-01-08T12:00:00.000Z',
          channel: 'general',
        }),
        createMessage('Alice', 'Agent2', 'First', {
          id: 'msg-2',
          isBroadcast: true,
          timestamp: '2026-01-08T12:00:00.000Z',
          channel: 'general',
        }),
        createMessage('Bob', 'Agent1', 'Second', {
          id: 'msg-3',
          isBroadcast: true,
          timestamp: '2026-01-08T12:00:30.000Z',
          channel: 'general',
        }),
        createMessage('Alice', 'Agent1', 'Third', {
          id: 'msg-4',
          isBroadcast: true,
          timestamp: '2026-01-08T12:01:00.000Z',
          channel: 'general',
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      expect(deduped).toHaveLength(3);
      expect(deduped[0].content).toBe('First');
      expect(deduped[1].content).toBe('Second');
      expect(deduped[2].content).toBe('Third');
    });

    it('should handle mixed broadcast and direct messages', () => {
      const messages: Message[] = [
        // Broadcast delivered to 2 recipients
        createMessage('Alice', 'Agent1', 'Broadcast', {
          id: 'broadcast-1',
          isBroadcast: true,
          timestamp: '2026-01-08T12:00:00.000Z',
          channel: 'general',
        }),
        createMessage('Alice', 'Agent2', 'Broadcast', {
          id: 'broadcast-2',
          isBroadcast: true,
          timestamp: '2026-01-08T12:00:00.000Z',
          channel: 'general',
        }),
        // Direct message
        createMessage('Bob', 'Alice', 'DM to Alice', {
          id: 'dm-1',
          isBroadcast: false,
          timestamp: '2026-01-08T12:00:30.000Z',
        }),
        // Another broadcast
        createMessage('Charlie', 'Agent1', 'Another broadcast', {
          id: 'broadcast-3',
          isBroadcast: true,
          timestamp: '2026-01-08T12:01:00.000Z',
          channel: 'general',
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      expect(deduped).toHaveLength(3);
      expect(deduped.map(m => m.content)).toEqual([
        'Broadcast',
        'DM to Alice',
        'Another broadcast',
      ]);
    });

    it('should keep first occurrence when deduplicating', () => {
      const timestamp = '2026-01-08T12:00:00.000Z';

      const messages: Message[] = [
        createMessage('Alice', 'Agent1', 'Hello everyone!', {
          id: 'first-delivery',
          isBroadcast: true,
          timestamp,
          channel: 'general',
        }),
        createMessage('Alice', 'Agent2', 'Hello everyone!', {
          id: 'second-delivery',
          isBroadcast: true,
          timestamp,
          channel: 'general',
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      // Should keep the first one (first-delivery)
      expect(deduped).toHaveLength(1);
      expect(deduped[0].id).toBe('first-delivery');
    });

    it('should handle empty message array', () => {
      const deduped = deduplicateBroadcasts([]);
      expect(deduped).toHaveLength(0);
    });

    it('should handle messages with to="*" as broadcasts even without isBroadcast flag', () => {
      const timestamp = '2026-01-08T12:00:00.000Z';

      // Messages with to='*' but no isBroadcast flag (legacy format)
      const messages: Message[] = [
        createMessage('Alice', '*', 'Broadcast message', {
          id: 'delivery-1',
          timestamp,
          channel: 'general',
        }),
        // Same message delivered to specific agent with isBroadcast flag
        createMessage('Alice', 'Agent1', 'Broadcast message', {
          id: 'delivery-2',
          isBroadcast: true,
          timestamp,
          channel: 'general',
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      // Should deduplicate - both represent the same broadcast
      expect(deduped).toHaveLength(1);
    });

    it('should differentiate broadcasts with same content but different senders', () => {
      const timestamp = '2026-01-08T12:00:00.000Z';

      const messages: Message[] = [
        createMessage('Alice', 'Agent1', 'Hello!', {
          id: 'alice-1',
          isBroadcast: true,
          timestamp,
          channel: 'general',
        }),
        createMessage('Bob', 'Agent1', 'Hello!', {
          id: 'bob-1',
          isBroadcast: true,
          timestamp,
          channel: 'general',
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      // Different senders, so both should appear
      expect(deduped).toHaveLength(2);
    });

    it('should handle timestamps within 1 second as same broadcast', () => {
      // Timestamps within 1 second should be grouped
      const messages: Message[] = [
        createMessage('Alice', 'Agent1', 'Quick message', {
          id: 'delivery-1',
          isBroadcast: true,
          timestamp: '2026-01-08T12:00:00.100Z',
          channel: 'general',
        }),
        createMessage('Alice', 'Agent2', 'Quick message', {
          id: 'delivery-2',
          isBroadcast: true,
          timestamp: '2026-01-08T12:00:00.500Z',
          channel: 'general',
        }),
        createMessage('Alice', 'Agent3', 'Quick message', {
          id: 'delivery-3',
          isBroadcast: true,
          timestamp: '2026-01-08T12:00:00.900Z',
          channel: 'general',
        }),
      ];

      const deduped = deduplicateBroadcasts(messages);

      // All within 1 second, same sender/content - should be 1 message
      expect(deduped).toHaveLength(1);
    });
  });

  describe('getBroadcastKey', () => {
    it('should generate consistent keys for same sender/content/timestamp', () => {
      const msg1 = createMessage('Alice', 'Agent1', 'Hello', {
        timestamp: '2026-01-08T12:00:00.000Z',
      });
      const msg2 = createMessage('Alice', 'Agent2', 'Hello', {
        timestamp: '2026-01-08T12:00:00.500Z', // Same second
      });

      expect(getBroadcastKey(msg1)).toBe(getBroadcastKey(msg2));
    });

    it('should generate different keys for different senders', () => {
      const msg1 = createMessage('Alice', 'Agent1', 'Hello', {
        timestamp: '2026-01-08T12:00:00.000Z',
      });
      const msg2 = createMessage('Bob', 'Agent1', 'Hello', {
        timestamp: '2026-01-08T12:00:00.000Z',
      });

      expect(getBroadcastKey(msg1)).not.toBe(getBroadcastKey(msg2));
    });

    it('should generate different keys for different content', () => {
      const msg1 = createMessage('Alice', 'Agent1', 'Hello', {
        timestamp: '2026-01-08T12:00:00.000Z',
      });
      const msg2 = createMessage('Alice', 'Agent1', 'Goodbye', {
        timestamp: '2026-01-08T12:00:00.000Z',
      });

      expect(getBroadcastKey(msg1)).not.toBe(getBroadcastKey(msg2));
    });

    it('should generate different keys for timestamps more than 1 second apart', () => {
      const msg1 = createMessage('Alice', 'Agent1', 'Hello', {
        timestamp: '2026-01-08T12:00:00.000Z',
      });
      const msg2 = createMessage('Alice', 'Agent1', 'Hello', {
        timestamp: '2026-01-08T12:00:02.000Z', // 2 seconds later
      });

      expect(getBroadcastKey(msg1)).not.toBe(getBroadcastKey(msg2));
    });
  });
});
