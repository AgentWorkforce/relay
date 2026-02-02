import { describe, it, expect, vi } from 'vitest';
import type {
  Envelope,
  ErrorPayload,
  WelcomePayload,
  DeliverEnvelope,
  AckPayload,
  StatusResponsePayload,
  ListAgentsResponsePayload,
  HealthResponsePayload,
  MetricsResponsePayload,
  InboxResponsePayload,
  AgentReadyPayload,
  SpawnResultPayload,
} from '@agent-relay/protocol';
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
          code: 'INTERNAL_ERROR' as any,
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

  describe('sendAndWait', () => {
    it('resolves when matching ACK arrives', async () => {
      const client = new RelayClient({ reconnect: false });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const promise = client.sendAndWait('Bob', 'ping', { timeoutMs: 1000 });
      const sentEnvelope = sendMock.mock.calls[0][0];
      const correlationId = sentEnvelope.payload_meta.sync.correlationId;

      const ackEnvelope: Envelope<AckPayload> = {
        v: 1,
        type: 'ACK',
        id: 'ack-1',
        ts: Date.now(),
        payload: {
          ack_id: 'd-1',
          seq: 1,
          correlationId,
          response: 'OK',
        },
      };

      (client as any).processFrame(ackEnvelope);

      await expect(promise).resolves.toMatchObject({ correlationId, response: 'OK' });
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();
      try {
        const client = new RelayClient({ reconnect: false });
        (client as any)._state = 'READY';
        const sendMock = vi.fn().mockReturnValue(true);
        (client as any).send = sendMock;

        const promise = client.sendAndWait('Bob', 'ping', { timeoutMs: 50 });
        const rejection = expect(promise).rejects.toThrow('ACK timeout');
        await vi.advanceTimersByTimeAsync(60);

        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects when not ready', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.sendAndWait('Bob', 'ping')).rejects.toThrow('Client not ready');
    });
  });

  describe('request', () => {
    it('resolves when matching response arrives via payload_meta.replyTo', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const promise = client.request('Worker', 'Do task', { timeout: 1000 });
      const sentEnvelope = sendMock.mock.calls[0][0];
      const correlationId = sentEnvelope.payload.data._correlationId;

      // Simulate response from Worker
      const responseEnvelope: DeliverEnvelope = {
        v: 1,
        type: 'DELIVER',
        id: 'response-1',
        ts: Date.now(),
        from: 'Worker',
        payload: {
          kind: 'message',
          body: 'Task completed',
          data: { result: 'success' },
        },
        payload_meta: {
          replyTo: correlationId,
        },
        delivery: {
          seq: 1,
          session_id: 'session-1',
        },
      };

      (client as any).processFrame(responseEnvelope);

      const result = await promise;
      expect(result.from).toBe('Worker');
      expect(result.body).toBe('Task completed');
      expect(result.data?.result).toBe('success');
      expect(result.correlationId).toBe(correlationId);
    });

    it('resolves when matching response arrives via data._correlationId', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const promise = client.request('Worker', 'Do task', { timeout: 1000 });
      const sentEnvelope = sendMock.mock.calls[0][0];
      const correlationId = sentEnvelope.payload.data._correlationId;

      // Simulate response from Worker using data._correlationId
      const responseEnvelope: DeliverEnvelope = {
        v: 1,
        type: 'DELIVER',
        id: 'response-2',
        ts: Date.now(),
        from: 'Worker',
        payload: {
          kind: 'message',
          body: 'Done!',
          data: { _correlationId: correlationId, _isResponse: true },
        },
        delivery: {
          seq: 2,
          session_id: 'session-1',
        },
      };

      (client as any).processFrame(responseEnvelope);

      const result = await promise;
      expect(result.from).toBe('Worker');
      expect(result.body).toBe('Done!');
      expect(result.correlationId).toBe(correlationId);
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();
      try {
        const client = new RelayClient({ reconnect: false, quiet: true });
        (client as any)._state = 'READY';
        const sendMock = vi.fn().mockReturnValue(true);
        (client as any).send = sendMock;

        const promise = client.request('Worker', 'Do task', { timeout: 50 });
        const rejection = expect(promise).rejects.toThrow('Request timeout after 50ms waiting for response from Worker');
        await vi.advanceTimersByTimeAsync(60);

        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects when not ready', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.request('Worker', 'Do task')).rejects.toThrow('Client not ready');
    });

    it('rejects when send fails', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(false);
      (client as any).send = sendMock;

      await expect(client.request('Worker', 'Do task')).rejects.toThrow('Failed to send request');
    });

    it('includes custom data and thread in the sent message', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      // Don't await - we just want to check what was sent
      client.request('Worker', 'Do task', {
        timeout: 1000,
        data: { taskId: '123', priority: 'high' },
        thread: 'task-thread-1',
      }).catch(() => {}); // Ignore timeout

      const sentEnvelope = sendMock.mock.calls[0][0];
      expect(sentEnvelope.to).toBe('Worker');
      expect(sentEnvelope.payload.body).toBe('Do task');
      expect(sentEnvelope.payload.data.taskId).toBe('123');
      expect(sentEnvelope.payload.data.priority).toBe('high');
      expect(sentEnvelope.payload.data._correlationId).toBeDefined();
      expect(sentEnvelope.payload.thread).toBe('task-thread-1');
      expect(sentEnvelope.payload_meta.replyTo).toBe(sentEnvelope.payload.data._correlationId);
    });

    it('still calls onMessage after resolving request', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const messages: any[] = [];
      client.onMessage = (from, payload) => messages.push({ from, payload });

      const promise = client.request('Worker', 'Do task', { timeout: 1000 });
      const sentEnvelope = sendMock.mock.calls[0][0];
      const correlationId = sentEnvelope.payload.data._correlationId;

      const responseEnvelope: DeliverEnvelope = {
        v: 1,
        type: 'DELIVER',
        id: 'response-3',
        ts: Date.now(),
        from: 'Worker',
        payload: {
          kind: 'message',
          body: 'Task completed',
        },
        payload_meta: {
          replyTo: correlationId,
        },
        delivery: {
          seq: 3,
          session_id: 'session-1',
        },
      };

      (client as any).processFrame(responseEnvelope);

      await promise;

      // onMessage should still be called
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('Worker');
      expect(messages[0].payload.body).toBe('Task completed');
    });
  });

  describe('respond', () => {
    it('returns false when not connected', () => {
      const client = new RelayClient({ reconnect: false });
      const result = client.respond('corr-123', 'Alice', 'Done');
      expect(result).toBe(false);
    });

    it('sends response with correlation ID', () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const result = client.respond('corr-123', 'Alice', 'Task completed', { result: 'success' });

      expect(result).toBe(true);
      const sentEnvelope = sendMock.mock.calls[0][0];
      expect(sentEnvelope.type).toBe('SEND');
      expect(sentEnvelope.to).toBe('Alice');
      expect(sentEnvelope.payload.body).toBe('Task completed');
      expect(sentEnvelope.payload.data._correlationId).toBe('corr-123');
      expect(sentEnvelope.payload.data._isResponse).toBe(true);
      expect(sentEnvelope.payload.data.result).toBe('success');
      expect(sentEnvelope.payload_meta.replyTo).toBe('corr-123');
    });
  });

  describe('channel operations', () => {
    it('should return false for joinChannel when not connected', () => {
      const client = new RelayClient({ reconnect: false });
      const result = client.joinChannel('#general');
      expect(result).toBe(false);
    });

    it('should return false for leaveChannel when not connected', () => {
      const client = new RelayClient({ reconnect: false });
      const result = client.leaveChannel('#general');
      expect(result).toBe(false);
    });

    it('should return false for sendChannelMessage when not connected', () => {
      const client = new RelayClient({ reconnect: false });
      const result = client.sendChannelMessage('#general', 'Hello');
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

  describe('query operations', () => {
    it('should reject getStatus when not ready', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.getStatus()).rejects.toThrow('Client not ready');
    });

    it('should reject listAgents when not ready', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.listAgents()).rejects.toThrow('Client not ready');
    });

    it('should reject getHealth when not ready', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.getHealth()).rejects.toThrow('Client not ready');
    });

    it('should reject getMetrics when not ready', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.getMetrics()).rejects.toThrow('Client not ready');
    });

    it('should reject getInbox when not ready', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.getInbox()).rejects.toThrow('Client not ready');
    });

    it('resolves getStatus when STATUS_RESPONSE arrives', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const promise = client.getStatus();
      const sentEnvelope = sendMock.mock.calls[0][0];

      const responseEnvelope: Envelope<StatusResponsePayload> = {
        v: 1,
        type: 'STATUS_RESPONSE',
        id: sentEnvelope.id,
        ts: Date.now(),
        payload: {
          version: '2.0.0',
          uptime: 12345,
          agentCount: 5,
        },
      };

      (client as any).processFrame(responseEnvelope);

      const result = await promise;
      expect(result.version).toBe('2.0.0');
      expect(result.uptime).toBe(12345);
      expect(result.agentCount).toBe(5);
    });

    it('resolves listAgents when LIST_AGENTS_RESPONSE arrives', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const promise = client.listAgents({ includeIdle: false });
      const sentEnvelope = sendMock.mock.calls[0][0];

      const responseEnvelope: Envelope<ListAgentsResponsePayload> = {
        v: 1,
        type: 'LIST_AGENTS_RESPONSE',
        id: sentEnvelope.id,
        ts: Date.now(),
        payload: {
          agents: [
            { name: 'Alice', cli: 'claude', idle: false },
            { name: 'Bob', cli: 'codex', idle: true },
          ],
        },
      };

      (client as any).processFrame(responseEnvelope);

      const result = await promise;
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Alice');
      expect(result[1].name).toBe('Bob');
    });

    it('resolves getHealth when HEALTH_RESPONSE arrives', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const promise = client.getHealth();
      const sentEnvelope = sendMock.mock.calls[0][0];

      const responseEnvelope: Envelope<HealthResponsePayload> = {
        v: 1,
        type: 'HEALTH_RESPONSE',
        id: sentEnvelope.id,
        ts: Date.now(),
        payload: {
          healthScore: 95,
          summary: 'System healthy',
          issues: [],
          recommendations: [],
          crashes: [],
          alerts: [],
          stats: { totalCrashes24h: 0, totalAlerts24h: 0, agentCount: 3 },
        },
      };

      (client as any).processFrame(responseEnvelope);

      const result = await promise;
      expect(result.healthScore).toBe(95);
      expect(result.summary).toBe('System healthy');
    });

    it('resolves getMetrics when METRICS_RESPONSE arrives', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const promise = client.getMetrics();
      const sentEnvelope = sendMock.mock.calls[0][0];

      const responseEnvelope: Envelope<MetricsResponsePayload> = {
        v: 1,
        type: 'METRICS_RESPONSE',
        id: sentEnvelope.id,
        ts: Date.now(),
        payload: {
          agents: [
            { name: 'Alice', status: 'active', rssBytes: 100000, cpuPercent: 5.2 },
          ],
          system: { totalMemory: 16000000, freeMemory: 8000000, heapUsed: 50000 },
        },
      };

      (client as any).processFrame(responseEnvelope);

      const result = await promise;
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe('Alice');
      expect(result.system.heapUsed).toBe(50000);
    });

    it('resolves getInbox when INBOX_RESPONSE arrives', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true, agentName: 'TestAgent' });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const promise = client.getInbox({ limit: 10 });
      const sentEnvelope = sendMock.mock.calls[0][0];

      const responseEnvelope: Envelope<InboxResponsePayload> = {
        v: 1,
        type: 'INBOX_RESPONSE',
        id: sentEnvelope.id,
        ts: Date.now(),
        payload: {
          messages: [
            { id: 'msg-1', from: 'Alice', body: 'Hello!', timestamp: Date.now() },
          ],
        },
      };

      (client as any).processFrame(responseEnvelope);

      const result = await promise;
      expect(result).toHaveLength(1);
      expect(result[0].from).toBe('Alice');
      expect(result[0].body).toBe('Hello!');
    });

    it('query times out if no response arrives', async () => {
      vi.useFakeTimers();
      try {
        const client = new RelayClient({ reconnect: false, quiet: true });
        (client as any)._state = 'READY';
        const sendMock = vi.fn().mockReturnValue(true);
        (client as any).send = sendMock;

        const promise = client.getStatus();
        const rejection = expect(promise).rejects.toThrow('Query timeout');
        await vi.advanceTimersByTimeAsync(6000);

        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('agent ready', () => {
    it('should call onAgentReady when AGENT_READY received', () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      const readyEvents: AgentReadyPayload[] = [];
      client.onAgentReady = (info) => readyEvents.push(info);

      const agentReadyEnvelope: Envelope<AgentReadyPayload> = {
        v: 1,
        type: 'AGENT_READY',
        id: 'ready-1',
        ts: Date.now(),
        payload: {
          name: 'Worker',
          cli: 'claude',
          task: 'Do something',
          connectedAt: Date.now(),
        },
      };

      (client as any).processFrame(agentReadyEnvelope);

      expect(readyEvents).toHaveLength(1);
      expect(readyEvents[0].name).toBe('Worker');
      expect(readyEvents[0].cli).toBe('claude');
    });

    it('resolves waitForAgentReady when AGENT_READY arrives', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';

      const promise = client.waitForAgentReady('Worker', 1000);

      const agentReadyEnvelope: Envelope<AgentReadyPayload> = {
        v: 1,
        type: 'AGENT_READY',
        id: 'ready-2',
        ts: Date.now(),
        payload: {
          name: 'Worker',
          cli: 'codex',
          connectedAt: Date.now(),
        },
      };

      (client as any).processFrame(agentReadyEnvelope);

      const result = await promise;
      expect(result.name).toBe('Worker');
      expect(result.cli).toBe('codex');
    });

    it('rejects waitForAgentReady on timeout', async () => {
      vi.useFakeTimers();
      try {
        const client = new RelayClient({ reconnect: false, quiet: true });
        (client as any)._state = 'READY';

        const promise = client.waitForAgentReady('Worker', 50);
        const rejection = expect(promise).rejects.toThrow('Agent Worker did not become ready within 50ms');
        await vi.advanceTimersByTimeAsync(60);

        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects waitForAgentReady when not ready', async () => {
      const client = new RelayClient({ reconnect: false });
      await expect(client.waitForAgentReady('Worker')).rejects.toThrow('Client not ready');
    });

    it('rejects waitForAgentReady when already waiting', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';

      // Start waiting
      client.waitForAgentReady('Worker', 10000).catch(() => {});

      // Try to wait again - should reject
      await expect(client.waitForAgentReady('Worker')).rejects.toThrow('Already waiting for agent Worker');
    });

    it('spawn with waitForReady resolves with ready info', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const spawnPromise = client.spawn(
        {
          name: 'Worker',
          cli: 'claude',
          task: 'Do work',
          waitForReady: true,
          readyTimeoutMs: 5000,
        },
        1000
      );

      // First, SPAWN_RESULT arrives
      const sentEnvelope = sendMock.mock.calls[0][0];
      const spawnResultEnvelope: Envelope<SpawnResultPayload> = {
        v: 1,
        type: 'SPAWN_RESULT',
        id: 'spawn-result-1',
        ts: Date.now(),
        payload: {
          replyTo: sentEnvelope.id,
          success: true,
          name: 'Worker',
          pid: 12345,
        },
      };
      (client as any).processFrame(spawnResultEnvelope);

      // Then, AGENT_READY arrives
      const agentReadyEnvelope: Envelope<AgentReadyPayload> = {
        v: 1,
        type: 'AGENT_READY',
        id: 'ready-3',
        ts: Date.now(),
        payload: {
          name: 'Worker',
          cli: 'claude',
          task: 'Do work',
          connectedAt: Date.now(),
        },
      };
      (client as any).processFrame(agentReadyEnvelope);

      const result = await spawnPromise;
      expect(result.success).toBe(true);
      expect(result.ready).toBe(true);
      expect(result.readyInfo?.name).toBe('Worker');
      expect(result.readyInfo?.cli).toBe('claude');
    });

    it('spawn with waitForReady returns ready:false on timeout', async () => {
      vi.useFakeTimers();
      try {
        const client = new RelayClient({ reconnect: false, quiet: true });
        (client as any)._state = 'READY';
        const sendMock = vi.fn().mockReturnValue(true);
        (client as any).send = sendMock;

        const spawnPromise = client.spawn(
          {
            name: 'Worker',
            cli: 'claude',
            waitForReady: true,
            readyTimeoutMs: 100,
          },
          500
        );

        // SPAWN_RESULT arrives
        const sentEnvelope = sendMock.mock.calls[0][0];
        const spawnResultEnvelope: Envelope<SpawnResultPayload> = {
          v: 1,
          type: 'SPAWN_RESULT',
          id: 'spawn-result-2',
          ts: Date.now(),
          payload: {
            replyTo: sentEnvelope.id,
            success: true,
            name: 'Worker',
            pid: 12346,
          },
        };
        (client as any).processFrame(spawnResultEnvelope);

        // Agent ready timeout expires
        await vi.advanceTimersByTimeAsync(150);

        const result = await spawnPromise;
        expect(result.success).toBe(true);
        expect(result.ready).toBe(false);
        expect(result.readyInfo).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('spawn without waitForReady does not wait for AGENT_READY', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const spawnPromise = client.spawn(
        {
          name: 'Worker',
          cli: 'claude',
        },
        1000
      );

      // SPAWN_RESULT arrives
      const sentEnvelope = sendMock.mock.calls[0][0];
      const spawnResultEnvelope: Envelope<SpawnResultPayload> = {
        v: 1,
        type: 'SPAWN_RESULT',
        id: 'spawn-result-3',
        ts: Date.now(),
        payload: {
          replyTo: sentEnvelope.id,
          success: true,
          name: 'Worker',
          pid: 12347,
        },
      };
      (client as any).processFrame(spawnResultEnvelope);

      const result = await spawnPromise;
      expect(result.success).toBe(true);
      expect(result.ready).toBeUndefined();
      expect(result.readyInfo).toBeUndefined();
    });

    it('spawn passes shadow options through to envelope payload', async () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const spawnPromise = client.spawn(
        {
          name: 'ShadowWorker',
          cli: 'claude',
          task: 'Review code',
          shadowMode: 'subagent',
          shadowOf: 'PrimaryAgent',
          shadowAgent: 'reviewer',
          shadowTriggers: ['CODE_WRITTEN', 'REVIEW_REQUEST'],
          shadowSpeakOn: ['EXPLICIT_ASK'],
        },
        1000
      );

      // Verify the envelope payload includes all shadow options
      const sentEnvelope = sendMock.mock.calls[0][0];
      expect(sentEnvelope.type).toBe('SPAWN');
      expect(sentEnvelope.payload.shadowMode).toBe('subagent');
      expect(sentEnvelope.payload.shadowOf).toBe('PrimaryAgent');
      expect(sentEnvelope.payload.shadowAgent).toBe('reviewer');
      expect(sentEnvelope.payload.shadowTriggers).toEqual(['CODE_WRITTEN', 'REVIEW_REQUEST']);
      expect(sentEnvelope.payload.shadowSpeakOn).toEqual(['EXPLICIT_ASK']);

      // Complete the spawn
      const spawnResultEnvelope: Envelope<SpawnResultPayload> = {
        v: 1,
        type: 'SPAWN_RESULT',
        id: 'spawn-result-shadow',
        ts: Date.now(),
        payload: {
          replyTo: sentEnvelope.id,
          success: true,
          name: 'ShadowWorker',
          pid: 12348,
        },
      };
      (client as any).processFrame(spawnResultEnvelope);

      const result = await spawnPromise;
      expect(result.success).toBe(true);
    });
  });

  describe('consensus operations', () => {
    it('should return false for createProposal when not connected', () => {
      const client = new RelayClient({ reconnect: false });
      const result = client.createProposal({
        title: 'Test',
        description: 'Test proposal',
        participants: ['Alice', 'Bob'],
      });
      expect(result).toBe(false);
    });

    it('should return false for vote when not connected', () => {
      const client = new RelayClient({ reconnect: false });
      const result = client.vote({
        proposalId: 'prop_123',
        value: 'approve',
      });
      expect(result).toBe(false);
    });

    it('should send PROPOSE command to _consensus', () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const result = client.createProposal({
        title: 'Approve design',
        description: 'Should we proceed?',
        participants: ['Alice', 'Bob', 'Charlie'],
        consensusType: 'supermajority',
        threshold: 0.75,
      });

      expect(result).toBe(true);
      expect(sendMock).toHaveBeenCalled();

      const envelope = sendMock.mock.calls[0][0];
      expect(envelope.type).toBe('SEND');
      expect(envelope.to).toBe('_consensus');
      expect(envelope.payload.body).toContain('PROPOSE: Approve design');
      expect(envelope.payload.body).toContain('TYPE: supermajority');
      expect(envelope.payload.body).toContain('PARTICIPANTS: Alice, Bob, Charlie');
      expect(envelope.payload.body).toContain('DESCRIPTION: Should we proceed?');
      expect(envelope.payload.body).toContain('THRESHOLD: 0.75');
    });

    it('should send VOTE command to _consensus', () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      const result = client.vote({
        proposalId: 'prop_123_abc',
        value: 'approve',
        reason: 'LGTM',
      });

      expect(result).toBe(true);
      expect(sendMock).toHaveBeenCalled();

      const envelope = sendMock.mock.calls[0][0];
      expect(envelope.type).toBe('SEND');
      expect(envelope.to).toBe('_consensus');
      expect(envelope.payload.body).toBe('VOTE prop_123_abc approve LGTM');
    });

    it('should send VOTE without reason', () => {
      const client = new RelayClient({ reconnect: false, quiet: true });
      (client as any)._state = 'READY';
      const sendMock = vi.fn().mockReturnValue(true);
      (client as any).send = sendMock;

      client.vote({
        proposalId: 'prop_456',
        value: 'reject',
      });

      const envelope = sendMock.mock.calls[0][0];
      expect(envelope.payload.body).toBe('VOTE prop_456 reject');
    });
  });
});
