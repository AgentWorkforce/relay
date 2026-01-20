/**
 * Unit tests for sync messaging protocol types.
 *
 * Tests the SyncMeta, SendMeta, and AckPayload interfaces
 * used for request-response and blocking message patterns.
 */
import { describe, it, expect } from 'vitest';
import type {
  SyncMeta,
  SendMeta,
  AckPayload,
  SendEnvelope,
  AckEnvelope,
} from './types.js';
import { PROTOCOL_VERSION } from './types.js';

describe('SyncMeta interface', () => {
  it('should accept valid SyncMeta with all fields', () => {
    const sync: SyncMeta = {
      correlationId: 'corr-123',
      timeoutMs: 30000,
      blocking: true,
    };

    expect(sync.correlationId).toBe('corr-123');
    expect(sync.timeoutMs).toBe(30000);
    expect(sync.blocking).toBe(true);
  });

  it('should accept SyncMeta with optional timeoutMs omitted', () => {
    const sync: SyncMeta = {
      correlationId: 'corr-456',
      blocking: false,
    };

    expect(sync.correlationId).toBe('corr-456');
    expect(sync.timeoutMs).toBeUndefined();
    expect(sync.blocking).toBe(false);
  });

  it('should require correlationId to be a string', () => {
    const sync: SyncMeta = {
      correlationId: crypto.randomUUID(),
      blocking: true,
    };

    expect(typeof sync.correlationId).toBe('string');
    expect(sync.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });
});

describe('SendMeta interface', () => {
  it('should accept SendMeta with sync field', () => {
    const meta: SendMeta = {
      requires_ack: true,
      ttl_ms: 60000,
      importance: 50,
      sync: {
        correlationId: 'sync-001',
        timeoutMs: 10000,
        blocking: true,
      },
    };

    expect(meta.sync?.correlationId).toBe('sync-001');
    expect(meta.sync?.timeoutMs).toBe(10000);
    expect(meta.sync?.blocking).toBe(true);
  });

  it('should accept SendMeta without sync field (backwards compatible)', () => {
    const meta: SendMeta = {
      requires_ack: false,
      importance: 100,
    };

    expect(meta.sync).toBeUndefined();
    expect(meta.requires_ack).toBe(false);
    expect(meta.importance).toBe(100);
  });

  it('should accept SendMeta with replyTo for legacy correlation', () => {
    const meta: SendMeta = {
      replyTo: 'original-msg-123',
      sync: {
        correlationId: 'corr-789',
        blocking: false,
      },
    };

    expect(meta.replyTo).toBe('original-msg-123');
    expect(meta.sync?.correlationId).toBe('corr-789');
  });
});

describe('AckPayload interface', () => {
  it('should accept AckPayload with correlation fields', () => {
    const ack: AckPayload = {
      ack_id: 'msg-001',
      seq: 1,
      correlationId: 'corr-001',
      response: 'OK',
      responseData: { status: 'processed' },
    };

    expect(ack.correlationId).toBe('corr-001');
    expect(ack.response).toBe('OK');
    expect(ack.responseData).toEqual({ status: 'processed' });
  });

  it('should accept AckPayload without correlation fields (backwards compatible)', () => {
    const ack: AckPayload = {
      ack_id: 'msg-002',
      seq: 5,
      cumulative_seq: 4,
    };

    expect(ack.correlationId).toBeUndefined();
    expect(ack.response).toBeUndefined();
    expect(ack.responseData).toBeUndefined();
  });

  it('should accept response as string status', () => {
    const successAck: AckPayload = {
      ack_id: 'msg-003',
      seq: 1,
      response: 'OK',
    };

    const errorAck: AckPayload = {
      ack_id: 'msg-004',
      seq: 1,
      response: 'ERROR',
      responseData: { error: 'injection_failed' },
    };

    expect(successAck.response).toBe('OK');
    expect(errorAck.response).toBe('ERROR');
  });

  it('should accept responseData as any type', () => {
    const withObject: AckPayload = {
      ack_id: 'msg-005',
      seq: 1,
      responseData: { key: 'value', nested: { data: true } },
    };

    const withArray: AckPayload = {
      ack_id: 'msg-006',
      seq: 1,
      responseData: [1, 2, 3],
    };

    const withString: AckPayload = {
      ack_id: 'msg-007',
      seq: 1,
      responseData: 'plain text response',
    };

    expect(withObject.responseData).toEqual({ key: 'value', nested: { data: true } });
    expect(withArray.responseData).toEqual([1, 2, 3]);
    expect(withString.responseData).toBe('plain text response');
  });
});

describe('SendEnvelope with sync metadata', () => {
  it('should create a blocking send envelope', () => {
    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'send-001',
      ts: Date.now(),
      to: 'ReceiverAgent',
      payload: {
        kind: 'message',
        body: 'Your turn. Play a card.',
      },
      payload_meta: {
        sync: {
          correlationId: 'game-turn-001',
          timeoutMs: 60000,
          blocking: true,
        },
      },
    };

    expect(envelope.payload_meta?.sync?.blocking).toBe(true);
    expect(envelope.payload_meta?.sync?.correlationId).toBe('game-turn-001');
    expect(envelope.payload_meta?.sync?.timeoutMs).toBe(60000);
  });

  it('should create a non-blocking send envelope (fire-and-forget)', () => {
    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'send-002',
      ts: Date.now(),
      to: 'Dashboard',
      payload: {
        kind: 'message',
        body: 'Status update: Game started',
      },
    };

    expect(envelope.payload_meta).toBeUndefined();
  });
});

describe('AckEnvelope for sync responses', () => {
  it('should create an ACK envelope with correlation', () => {
    const envelope: AckEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: 'ack-001',
      ts: Date.now(),
      payload: {
        ack_id: 'deliver-001',
        seq: 1,
        correlationId: 'game-turn-001',
        response: 'OK',
        responseData: { card: '3C' },
      },
    };

    expect(envelope.payload.correlationId).toBe('game-turn-001');
    expect(envelope.payload.response).toBe('OK');
    expect(envelope.payload.responseData).toEqual({ card: '3C' });
  });

  it('should create an error ACK envelope', () => {
    const envelope: AckEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: 'ack-002',
      ts: Date.now(),
      payload: {
        ack_id: 'deliver-002',
        seq: 2,
        correlationId: 'game-turn-002',
        response: 'ERROR',
        responseData: { error: 'timeout', message: 'Agent did not respond in time' },
      },
    };

    expect(envelope.payload.response).toBe('ERROR');
    expect(envelope.payload.responseData).toHaveProperty('error', 'timeout');
  });
});

describe('Backwards compatibility', () => {
  it('SendMeta should work without any sync fields', () => {
    // Pre-sync messaging usage pattern
    const meta: SendMeta = {
      requires_ack: true,
      ttl_ms: 30000,
      importance: 75,
    };

    expect(meta.sync).toBeUndefined();
    expect(meta.requires_ack).toBe(true);
  });

  it('AckPayload should work without any correlation fields', () => {
    // Pre-sync messaging usage pattern
    const ack: AckPayload = {
      ack_id: 'legacy-001',
      seq: 10,
      cumulative_seq: 9,
      sack: [7, 8],
    };

    expect(ack.correlationId).toBeUndefined();
    expect(ack.response).toBeUndefined();
    expect(ack.responseData).toBeUndefined();
  });
});
