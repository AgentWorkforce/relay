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
      client.onMessage = (from, payload, id, meta, originalTo) => messages.push({ from, payload, id, originalTo });

      // DELIVER envelope has delivery info and from at envelope level
      const deliverEnvelope: DeliverEnvelope = {
        v: 1,
        type: 'DELIVER',
        id: 'msg-1',
        ts: Date.now(),
        from: 'Alice',
        payload: {
          kind: 'message',
          body: 'Hello!',
        },
        delivery: {
          seq: 1,
          session_id: 'session-1',
        },
      };

      (client as any).processFrame(deliverEnvelope);

      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('Alice');
      expect(messages[0].payload.body).toBe('Hello!');
      expect(messages[0].originalTo).toBeUndefined();
    });

    it('should pass originalTo for broadcast messages', () => {
      const client = new RelayClient({ reconnect: false });
      const messages: any[] = [];
      client.onMessage = (from, payload, id, meta, originalTo) => messages.push({ from, payload, id, originalTo });

      // DELIVER envelope for a broadcast message includes originalTo: '*'
      const deliverEnvelope: DeliverEnvelope = {
        v: 1,
        type: 'DELIVER',
        id: 'msg-2',
        ts: Date.now(),
        from: 'Dashboard',
        to: 'Bob',
        payload: {
          kind: 'message',
          body: 'Hello everyone!',
        },
        delivery: {
          seq: 1,
          session_id: 'session-1',
          originalTo: '*', // This was a broadcast
        },
      };

      (client as any).processFrame(deliverEnvelope);

      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('Dashboard');
      expect(messages[0].payload.body).toBe('Hello everyone!');
      expect(messages[0].originalTo).toBe('*');
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

  describe('spawn (SDK Contract)', () => {
    it('should have spawn method', () => {
      const client = new RelayClient({ reconnect: false });
      expect(typeof client.spawn).toBe('function');
    });

    it('should reject when not connected', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(
        client.spawn({ name: 'TestWorker', cli: 'claude', task: 'Test task' })
      ).rejects.toThrow('Client not ready');
    });

    it('should reject when in wrong state', async () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'CONNECTING';
      await expect(
        client.spawn({ name: 'TestWorker', cli: 'claude', task: 'Test task' })
      ).rejects.toThrow('Client not ready');
    });

    it('should handle SPAWN_RESULT response', async () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'READY';

      // Mock the socket write to capture the envelope
      let sentEnvelope: any;
      (client as any).socket = {
        write: (data: Buffer) => {
          // Parse the frame to get the envelope
          const length = data.readUInt32BE(0);
          const json = data.subarray(4, 4 + length).toString('utf-8');
          sentEnvelope = JSON.parse(json);
          return true;
        },
      };

      // Start spawn request (will pend)
      const spawnPromise = client.spawn({
        name: 'Worker1',
        cli: 'claude',
        task: 'Do something',
      });

      // Give time for the request to be sent
      await new Promise((r) => setTimeout(r, 10));

      // Verify the request was sent
      expect(sentEnvelope).toBeDefined();
      expect(sentEnvelope.type).toBe('SPAWN');
      expect(sentEnvelope.payload.name).toBe('Worker1');
      expect(sentEnvelope.payload.cli).toBe('claude');

      // Simulate SPAWN_RESULT response
      const resultEnvelope = {
        v: 1,
        type: 'SPAWN_RESULT',
        id: 'result-1',
        ts: Date.now(),
        payload: {
          replyTo: sentEnvelope.id,
          success: true,
          name: 'Worker1',
          pid: 12345,
        },
      };
      (client as any).processFrame(resultEnvelope);

      // Await the spawn result
      const result = await spawnPromise;
      expect(result.success).toBe(true);
      expect(result.name).toBe('Worker1');
      expect(result.pid).toBe(12345);
    });

    it('should handle spawn failure', async () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'READY';

      let sentEnvelope: any;
      (client as any).socket = {
        write: (data: Buffer) => {
          const length = data.readUInt32BE(0);
          const json = data.subarray(4, 4 + length).toString('utf-8');
          sentEnvelope = JSON.parse(json);
          return true;
        },
      };

      const spawnPromise = client.spawn({
        name: 'FailWorker',
        cli: 'nonexistent',
        task: 'Will fail',
      });

      await new Promise((r) => setTimeout(r, 10));

      // Simulate failure response
      const resultEnvelope = {
        v: 1,
        type: 'SPAWN_RESULT',
        id: 'result-2',
        ts: Date.now(),
        payload: {
          replyTo: sentEnvelope.id,
          success: false,
          name: 'FailWorker',
          error: 'Command not found',
        },
      };
      (client as any).processFrame(resultEnvelope);

      const result = await spawnPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Command not found');
    });
  });

  describe('release (SDK Contract)', () => {
    it('should have release method', () => {
      const client = new RelayClient({ reconnect: false });
      expect(typeof client.release).toBe('function');
    });

    it('should reject when not connected', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.release('SomeWorker')).rejects.toThrow('Client not ready');
    });

    it('should handle RELEASE_RESULT response', async () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'READY';

      let sentEnvelope: any;
      (client as any).socket = {
        write: (data: Buffer) => {
          const length = data.readUInt32BE(0);
          const json = data.subarray(4, 4 + length).toString('utf-8');
          sentEnvelope = JSON.parse(json);
          return true;
        },
      };

      const releasePromise = client.release('Worker1');

      await new Promise((r) => setTimeout(r, 10));

      expect(sentEnvelope).toBeDefined();
      expect(sentEnvelope.type).toBe('RELEASE');
      expect(sentEnvelope.payload.name).toBe('Worker1');

      // Simulate RELEASE_RESULT response
      const resultEnvelope = {
        v: 1,
        type: 'RELEASE_RESULT',
        id: 'release-result-1',
        ts: Date.now(),
        payload: {
          replyTo: sentEnvelope.id,
          success: true,
          name: 'Worker1',
        },
      };
      (client as any).processFrame(resultEnvelope);

      const success = await releasePromise;
      expect(success).toBe(true);
    });

    it('should handle release failure', async () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'READY';

      let sentEnvelope: any;
      (client as any).socket = {
        write: (data: Buffer) => {
          const length = data.readUInt32BE(0);
          const json = data.subarray(4, 4 + length).toString('utf-8');
          sentEnvelope = JSON.parse(json);
          return true;
        },
      };

      const releasePromise = client.release('NonExistent');

      await new Promise((r) => setTimeout(r, 10));

      // Simulate failure response
      const resultEnvelope = {
        v: 1,
        type: 'RELEASE_RESULT',
        id: 'release-result-2',
        ts: Date.now(),
        payload: {
          replyTo: sentEnvelope.id,
          success: false,
          name: 'NonExistent',
          error: 'Worker not found',
        },
      };
      (client as any).processFrame(resultEnvelope);

      const success = await releasePromise;
      expect(success).toBe(false);
    });
  });
});
