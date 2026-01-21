/**
 * Protocol Types Tests
 *
 * These tests verify the SDK contract - the types and constants that
 * SDK consumers depend on. Any breaking change here would break SDK users.
 */

import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  type Envelope,
  type MessageType,
  type PayloadKind,
  type SendPayload,
  type HelloPayload,
  type WelcomePayload,
  type DeliveryInfo,
  type EntityType,
} from './types.js';

describe('Protocol Types (SDK Contract)', () => {
  describe('PROTOCOL_VERSION', () => {
    it('should be 1', () => {
      expect(PROTOCOL_VERSION).toBe(1);
    });

    it('should be a number', () => {
      expect(typeof PROTOCOL_VERSION).toBe('number');
    });
  });

  describe('Envelope structure', () => {
    it('should accept valid envelope with required fields', () => {
      const envelope: Envelope<SendPayload> = {
        v: 1,
        type: 'SEND',
        id: 'test-id-123',
        ts: Date.now(),
        payload: {
          kind: 'message',
          body: 'Hello world',
        },
      };

      expect(envelope.v).toBe(1);
      expect(envelope.type).toBe('SEND');
      expect(envelope.id).toBe('test-id-123');
      expect(typeof envelope.ts).toBe('number');
      expect(envelope.payload.body).toBe('Hello world');
    });

    it('should accept optional fields', () => {
      const envelope: Envelope<SendPayload> = {
        v: 1,
        type: 'SEND',
        id: 'test-id',
        ts: Date.now(),
        from: 'Alice',
        to: 'Bob',
        topic: 'test-topic',
        payload: {
          kind: 'message',
          body: 'Hello',
        },
      };

      expect(envelope.from).toBe('Alice');
      expect(envelope.to).toBe('Bob');
      expect(envelope.topic).toBe('test-topic');
    });

    it('should accept broadcast target', () => {
      const envelope: Envelope<SendPayload> = {
        v: 1,
        type: 'SEND',
        id: 'broadcast-id',
        ts: Date.now(),
        to: '*',
        payload: {
          kind: 'message',
          body: 'Hello everyone',
        },
      };

      expect(envelope.to).toBe('*');
    });
  });

  describe('MessageType', () => {
    it('should include core messaging types', () => {
      const coreTypes: MessageType[] = [
        'HELLO',
        'WELCOME',
        'SEND',
        'DELIVER',
        'ACK',
        'NACK',
        'PING',
        'PONG',
        'ERROR',
      ];

      // This compiles only if these are valid MessageType values
      coreTypes.forEach((t) => {
        expect(typeof t).toBe('string');
      });
    });

    it('should include spawn/release types', () => {
      const spawnTypes: MessageType[] = [
        'SPAWN',
        'SPAWN_RESULT',
        'RELEASE',
        'RELEASE_RESULT',
      ];

      spawnTypes.forEach((t) => {
        expect(typeof t).toBe('string');
      });
    });

    it('should include channel types', () => {
      const channelTypes: MessageType[] = [
        'CHANNEL_JOIN',
        'CHANNEL_LEAVE',
        'CHANNEL_MESSAGE',
        'CHANNEL_INFO',
        'CHANNEL_MEMBERS',
      ];

      channelTypes.forEach((t) => {
        expect(typeof t).toBe('string');
      });
    });
  });

  describe('PayloadKind', () => {
    it('should include expected kinds', () => {
      const kinds: PayloadKind[] = ['message', 'action', 'state', 'thinking'];

      kinds.forEach((k) => {
        expect(typeof k).toBe('string');
      });
    });
  });

  describe('SendPayload', () => {
    it('should require kind and body', () => {
      const payload: SendPayload = {
        kind: 'message',
        body: 'Test message',
      };

      expect(payload.kind).toBe('message');
      expect(payload.body).toBe('Test message');
    });

    it('should accept optional data and thread', () => {
      const payload: SendPayload = {
        kind: 'action',
        body: 'Doing something',
        data: { foo: 'bar', count: 42 },
        thread: 'thread-123',
      };

      expect(payload.data).toEqual({ foo: 'bar', count: 42 });
      expect(payload.thread).toBe('thread-123');
    });
  });

  describe('HelloPayload', () => {
    it('should require agent name and capabilities', () => {
      const hello: HelloPayload = {
        agent: 'TestAgent',
        capabilities: {
          ack: true,
          resume: false,
          max_inflight: 10,
          supports_topics: true,
        },
      };

      expect(hello.agent).toBe('TestAgent');
      expect(hello.capabilities.ack).toBe(true);
      expect(hello.capabilities.max_inflight).toBe(10);
    });

    it('should accept optional fields for SDK usage', () => {
      const hello: HelloPayload = {
        agent: 'TestAgent',
        capabilities: {
          ack: true,
          resume: false,
          max_inflight: 10,
          supports_topics: false,
        },
        entityType: 'agent',
        cli: 'claude',
        program: 'claude',
        model: 'claude-3-opus',
        task: 'Implementing feature X',
        workingDirectory: '/home/user/project',
      };

      expect(hello.entityType).toBe('agent');
      expect(hello.cli).toBe('claude');
      expect(hello.task).toBe('Implementing feature X');
    });
  });

  describe('WelcomePayload', () => {
    it('should contain session info', () => {
      const welcome: WelcomePayload = {
        session_id: 'session-abc-123',
        server: {
          max_frame_bytes: 1024 * 1024,
          heartbeat_ms: 5000,
        },
      };

      expect(welcome.session_id).toBe('session-abc-123');
      expect(welcome.server.max_frame_bytes).toBe(1024 * 1024);
      expect(welcome.server.heartbeat_ms).toBe(5000);
    });

    it('should accept optional resume_token', () => {
      const welcome: WelcomePayload = {
        session_id: 'session-xyz',
        resume_token: 'resume-token-value',
        server: {
          max_frame_bytes: 1024 * 1024,
          heartbeat_ms: 5000,
        },
      };

      expect(welcome.resume_token).toBe('resume-token-value');
    });
  });

  describe('DeliveryInfo', () => {
    it('should contain sequence and session', () => {
      const delivery: DeliveryInfo = {
        seq: 42,
        session_id: 'session-123',
      };

      expect(delivery.seq).toBe(42);
      expect(delivery.session_id).toBe('session-123');
    });

    it('should include originalTo for broadcasts', () => {
      const delivery: DeliveryInfo = {
        seq: 1,
        session_id: 'session-456',
        originalTo: '*',
      };

      expect(delivery.originalTo).toBe('*');
    });
  });

  describe('EntityType', () => {
    it('should support agent and user types', () => {
      const agentType: EntityType = 'agent';
      const userType: EntityType = 'user';

      expect(agentType).toBe('agent');
      expect(userType).toBe('user');
    });
  });
});
