/**
 * SDK Public API Contract Tests
 *
 * These tests verify the public API that SDK consumers depend on.
 * If any of these tests fail, it indicates a breaking change to the SDK.
 *
 * IMPORTANT: Do not modify these tests without careful consideration.
 * They represent the contract we maintain with SDK users.
 */

import { describe, it, expect } from 'vitest';

describe('SDK Public API Contract', () => {
  describe('RelayClient exports', () => {
    it('exports RelayClient class', async () => {
      const mod = await import('@agent-relay/wrapper');
      expect(mod.RelayClient).toBeDefined();
      expect(typeof mod.RelayClient).toBe('function');
    });

    it('exports SpawnRequest type', async () => {
      // TypeScript will catch type export issues at compile time
      // This test verifies runtime that the module loads correctly
      const mod = await import('@agent-relay/wrapper');
      expect(mod).toBeDefined();
    });

    it('exports SpawnResult type', async () => {
      const mod = await import('@agent-relay/wrapper');
      expect(mod).toBeDefined();
    });
  });

  describe('Protocol exports', () => {
    it('exports PROTOCOL_VERSION constant', async () => {
      const mod = await import('@agent-relay/protocol/types');
      expect(mod.PROTOCOL_VERSION).toBe(1);
      expect(typeof mod.PROTOCOL_VERSION).toBe('number');
    });

    it('exports all required types', async () => {
      // This test verifies the module loads without errors
      // TypeScript compilation will catch missing type exports
      const mod = await import('@agent-relay/protocol/types');
      expect(mod).toBeDefined();
    });
  });

  describe('Framing exports', () => {
    it('exports encodeFrame function', async () => {
      const mod = await import('@agent-relay/protocol/framing');
      expect(typeof mod.encodeFrame).toBe('function');
    });

    it('exports encodeFrameLegacy function', async () => {
      const mod = await import('@agent-relay/protocol/framing');
      expect(typeof mod.encodeFrameLegacy).toBe('function');
    });

    it('exports FrameParser class', async () => {
      const mod = await import('@agent-relay/protocol/framing');
      expect(typeof mod.FrameParser).toBe('function');
    });

    it('exports MAX_FRAME_BYTES constant', async () => {
      const mod = await import('@agent-relay/protocol/framing');
      expect(mod.MAX_FRAME_BYTES).toBe(1024 * 1024); // 1 MiB
    });
  });

  describe('RelayClient API surface', () => {
    it('has all expected instance methods', async () => {
      const { RelayClient } = await import('@agent-relay/wrapper');
      const client = new RelayClient({});

      // Core lifecycle
      expect(typeof client.connect).toBe('function');
      expect(typeof client.disconnect).toBe('function');
      expect(typeof client.destroy).toBe('function');

      // Messaging
      expect(typeof client.sendMessage).toBe('function');
      expect(typeof client.broadcast).toBe('function');

      // Topics/subscriptions
      expect(typeof client.subscribe).toBe('function');
      expect(typeof client.unsubscribe).toBe('function');

      // Logging
      expect(typeof client.sendLog).toBe('function');

      // TODO: spawn/release methods will be added as part of daemon-spawning work
      // See: docs/SDK-MIGRATION-PLAN.md
    });

    it('has all expected instance properties', async () => {
      const { RelayClient } = await import('@agent-relay/wrapper');
      const client = new RelayClient({ agentName: 'TestAgent' });

      // State
      expect(client.state).toBe('DISCONNECTED');
      expect(typeof client.state).toBe('string');

      // Agent name
      expect(client.agentName).toBe('TestAgent');
    });

    it('has expected callback properties', async () => {
      const { RelayClient } = await import('@agent-relay/wrapper');
      const client = new RelayClient({});

      // These should be assignable
      client.onMessage = () => {};
      client.onStateChange = () => {};
      client.onError = () => {};

      // Verify they were assigned
      expect(typeof client.onMessage).toBe('function');
      expect(typeof client.onStateChange).toBe('function');
      expect(typeof client.onError).toBe('function');
    });

    it('accepts expected config options', async () => {
      const { RelayClient } = await import('@agent-relay/wrapper');

      // Should not throw with valid config
      const client = new RelayClient({
        agentName: 'TestAgent',
        socketPath: '/tmp/test.sock',
        reconnect: true,
        maxReconnectAttempts: 5,
        reconnectIntervalMs: 1000,
        debug: false,
      });

      expect(client).toBeDefined();
    });
  });

  describe('RelayClient state machine', () => {
    it('starts in DISCONNECTED state', async () => {
      const { RelayClient } = await import('@agent-relay/wrapper');
      const client = new RelayClient({});
      expect(client.state).toBe('DISCONNECTED');
    });

    it('has valid state values', async () => {
      const { RelayClient } = await import('@agent-relay/wrapper');
      const client = new RelayClient({});

      // Valid states that SDK users might check
      const validStates = ['DISCONNECTED', 'CONNECTING', 'READY', 'RECONNECTING'];

      // Starting state should be valid
      expect(validStates).toContain(client.state);
    });
  });

  describe('Framing compatibility', () => {
    it('can encode and decode envelopes', async () => {
      const { encodeFrameLegacy, FrameParser } = await import('@agent-relay/protocol/framing');

      const envelope = {
        v: 1,
        type: 'SEND' as const,
        id: 'test-id',
        ts: Date.now(),
        to: 'Alice',
        payload: {
          kind: 'message' as const,
          body: 'Hello!',
        },
      };

      const frame = encodeFrameLegacy(envelope);
      expect(frame).toBeInstanceOf(Buffer);

      const parser = new FrameParser();
      parser.setLegacyMode(true);
      const [decoded] = parser.push(frame);

      expect(decoded.type).toBe('SEND');
      expect(decoded.payload).toEqual(envelope.payload);
    });

    it('handles streaming data correctly', async () => {
      const { encodeFrameLegacy, FrameParser } = await import('@agent-relay/protocol/framing');

      const envelope = {
        v: 1,
        type: 'PING' as const,
        id: 'stream-test',
        ts: Date.now(),
        payload: { nonce: 'abc' },
      };

      const frame = encodeFrameLegacy(envelope);
      const parser = new FrameParser();
      parser.setLegacyMode(true);

      // Send frame in chunks (simulating network)
      const chunk1 = frame.subarray(0, 5);
      const chunk2 = frame.subarray(5);

      let result = parser.push(chunk1);
      expect(result).toHaveLength(0); // Not complete

      result = parser.push(chunk2);
      expect(result).toHaveLength(1); // Now complete
      expect(result[0].type).toBe('PING');
    });
  });

  describe('Message sending contract', () => {
    it('sendMessage returns false when not connected', async () => {
      const { RelayClient } = await import('@agent-relay/wrapper');
      const client = new RelayClient({});

      const result = client.sendMessage('Alice', 'Hello');
      expect(result).toBe(false);
    });

    it('broadcast returns false when not connected', async () => {
      const { RelayClient } = await import('@agent-relay/wrapper');
      const client = new RelayClient({});

      const result = client.broadcast('Hello everyone');
      expect(result).toBe(false);
    });
  });

  // TODO: Spawn/Release contract tests will be added when daemon-spawning is implemented
  // See: docs/SDK-MIGRATION-PLAN.md for planned implementation
});
