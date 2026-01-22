/**
 * Tests for CloudMessageBus service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cloudMessageBus, type CloudMessage } from './cloud-message-bus.js';

describe('CloudMessageBus', () => {
  beforeEach(() => {
    // Remove all listeners between tests
    cloudMessageBus.removeAllListeners();
  });

  describe('sendToUser', () => {
    it('should emit user-message event with username and message', () => {
      const handler = vi.fn();
      cloudMessageBus.on('user-message', handler);

      const message: CloudMessage = {
        from: {
          daemonId: 'daemon-123',
          daemonName: 'Local Daemon',
          agent: 'Lead',
        },
        to: 'khaliqgant',
        body: 'Hello from Lead!',
        timestamp: '2026-01-18T00:00:00Z',
      };

      cloudMessageBus.sendToUser('khaliqgant', message);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        username: 'khaliqgant',
        message,
      });
    });

    it('should include optional metadata in message', () => {
      const handler = vi.fn();
      cloudMessageBus.on('user-message', handler);

      const message: CloudMessage = {
        from: {
          daemonId: 'daemon-123',
          daemonName: 'Local Daemon',
          agent: 'Lead',
        },
        to: 'khaliqgant',
        body: 'Task update',
        timestamp: '2026-01-18T00:00:00Z',
        metadata: {
          taskId: 'task-456',
          priority: 'high',
        },
      };

      cloudMessageBus.sendToUser('khaliqgant', message);

      expect(handler).toHaveBeenCalledWith({
        username: 'khaliqgant',
        message: expect.objectContaining({
          metadata: {
            taskId: 'task-456',
            priority: 'high',
          },
        }),
      });
    });

    it('should support multiple subscribers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      cloudMessageBus.on('user-message', handler1);
      cloudMessageBus.on('user-message', handler2);

      const message: CloudMessage = {
        from: {
          daemonId: 'daemon-123',
          daemonName: 'Local Daemon',
          agent: 'Lead',
        },
        to: 'alice',
        body: 'Hello!',
        timestamp: '2026-01-18T00:00:00Z',
      };

      cloudMessageBus.sendToUser('alice', message);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should deliver messages to different users independently', () => {
      const handler = vi.fn();
      cloudMessageBus.on('user-message', handler);

      const message1: CloudMessage = {
        from: {
          daemonId: 'daemon-123',
          daemonName: 'Local Daemon',
          agent: 'Lead',
        },
        to: 'alice',
        body: 'Hello Alice!',
        timestamp: '2026-01-18T00:00:00Z',
      };

      const message2: CloudMessage = {
        from: {
          daemonId: 'daemon-123',
          daemonName: 'Local Daemon',
          agent: 'Lead',
        },
        to: 'bob',
        body: 'Hello Bob!',
        timestamp: '2026-01-18T00:00:01Z',
      };

      cloudMessageBus.sendToUser('alice', message1);
      cloudMessageBus.sendToUser('bob', message2);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, {
        username: 'alice',
        message: message1,
      });
      expect(handler).toHaveBeenNthCalledWith(2, {
        username: 'bob',
        message: message2,
      });
    });
  });

  describe('event handling', () => {
    it('should allow removing specific listeners', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      cloudMessageBus.on('user-message', handler1);
      cloudMessageBus.on('user-message', handler2);
      cloudMessageBus.off('user-message', handler1);

      const message: CloudMessage = {
        from: {
          daemonId: 'daemon-123',
          daemonName: 'Local Daemon',
          agent: 'Lead',
        },
        to: 'alice',
        body: 'Hello!',
        timestamp: '2026-01-18T00:00:00Z',
      };

      cloudMessageBus.sendToUser('alice', message);

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should handle no subscribers gracefully', () => {
      const message: CloudMessage = {
        from: {
          daemonId: 'daemon-123',
          daemonName: 'Local Daemon',
          agent: 'Lead',
        },
        to: 'alice',
        body: 'Hello!',
        timestamp: '2026-01-18T00:00:00Z',
      };

      // Should not throw
      expect(() => cloudMessageBus.sendToUser('alice', message)).not.toThrow();
    });
  });
});
