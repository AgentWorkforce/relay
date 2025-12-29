import { describe, it, expect } from 'vitest';
import type { Envelope, ErrorPayload, WelcomePayload, DeliverEnvelope } from '../protocol/types.js';
import { RelayClient } from './client.js';

describe('RelayClient', () => {
  describe('configuration', () => {
    it('should use default config values', () => {
      const client = new RelayClient({});
      expect(client.state).toBe('DISCONNECTED');
    });

    it('should accept custom config', () => {
      const client = new RelayClient({
        agentName: 'TestAgent',
        socketPath: '/custom/socket.sock',
        reconnect: false,
        maxReconnectAttempts: 5,
      });
      expect(client.state).toBe('DISCONNECTED');
    });

    it('should use agentName from config', () => {
      const client = new RelayClient({ agentName: 'CustomAgent' });
      // agentName is stored internally
      expect((client as any).config.agentName).toBe('CustomAgent');
    });
  });

  describe('state management', () => {
    it('should start in DISCONNECTED state', () => {
      const client = new RelayClient({});
      expect(client.state).toBe('DISCONNECTED');
    });

    it('should notify on state change', () => {
      const client = new RelayClient({ reconnect: false });
      const states: string[] = [];
      client.onStateChange = (state) => states.push(state);

      // Trigger internal state changes using setState
      (client as any).setState('CONNECTING');
      (client as any).setState('READY');

      expect(states).toContain('CONNECTING');
      expect(states).toContain('READY');
    });
  });

  describe('message handling', () => {
    it('should call onMessage when DELIVER received', () => {
      const client = new RelayClient({ reconnect: false });
      const messages: any[] = [];
      client.onMessage = (from, payload, id) => messages.push({ from, payload, id });

      // DELIVER envelope has delivery info and from at envelope level
      const deliverEnvelope: DeliverEnvelope = {
        v: 1,
        type: 'DELIVER',
        id: 'msg-1',
        ts: Date.now(),
        from: 'Alice',
        payload: {
          from: 'Alice',
          to: 'Bob',
          body: 'Hello!',
        },
        delivery: {
          topic: 'dm',
          seq: 1,
        },
      };

      (client as any).processFrame(deliverEnvelope);

      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('Alice');
      expect(messages[0].payload.body).toBe('Hello!');
    });

    it('should handle WELCOME and transition to READY', () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'CONNECTING';

      const welcomeEnvelope: Envelope<WelcomePayload> = {
        v: 1,
        type: 'WELCOME',
        id: 'welcome-1',
        ts: Date.now(),
        payload: {
          session_id: 'session-123',
          server: {
            max_frame_bytes: 1024 * 1024,
            heartbeat_ms: 5000,
          },
        },
      };

      (client as any).processFrame(welcomeEnvelope);

      expect(client.state).toBe('READY');
    });
  });

  describe('error handling', () => {
    it('clears resume token after RESUME_TOO_OLD error', () => {
      const client = new RelayClient({ reconnect: false });

      // Simulate a stored resume token that the server rejects
      (client as any).resumeToken = 'stale-token';

      const errorEnvelope: Envelope<ErrorPayload> = {
        v: 1,
        type: 'ERROR',
        id: 'err-1',
        ts: Date.now(),
        payload: {
          code: 'RESUME_TOO_OLD',
          message: 'Session resume not yet supported; starting new session',
          fatal: false,
        },
      };

      (client as any).processFrame(errorEnvelope);

      expect((client as any).resumeToken).toBeUndefined();
    });

    it('should handle ERROR frames without crashing', () => {
      const client = new RelayClient({ reconnect: false });

      const errorEnvelope: Envelope<ErrorPayload> = {
        v: 1,
        type: 'ERROR',
        id: 'err-1',
        ts: Date.now(),
        payload: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong',
          fatal: true,
        },
      };

      // Should not throw
      expect(() => (client as any).processFrame(errorEnvelope)).not.toThrow();
    });
  });

  describe('sendMessage', () => {
    it('should return false when not connected', () => {
      const client = new RelayClient({ reconnect: false });
      const result = client.sendMessage('Alice', 'Hello');
      expect(result).toBe(false);
    });

    it('should return false when in wrong state', () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'CONNECTING';
      const result = client.sendMessage('Alice', 'Hello');
      expect(result).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should transition to DISCONNECTED state', () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'READY';

      client.disconnect();

      expect(client.state).toBe('DISCONNECTED');
    });
  });
});
