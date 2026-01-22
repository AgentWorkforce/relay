import { describe, it, expect } from 'vitest';
import {
  encodeFrame,
  encodeFrameLegacy,
  FrameParser,
  HEADER_SIZE,
  LEGACY_HEADER_SIZE,
  MAX_FRAME_BYTES,
} from './framing.js';
import type { Envelope } from './types.js';

describe('protocol framing', () => {
  describe('legacy format (4-byte header)', () => {
    it('roundtrips an envelope with correct length prefix', () => {
      const envelope: Envelope = {
        v: 1,
        type: 'PING',
        id: 'test-1',
        ts: 1,
        payload: { nonce: 'abc' },
      };

      const frame = encodeFrameLegacy(envelope);
      const declaredLength = frame.readUInt32BE(0);
      const jsonBytes = frame.subarray(LEGACY_HEADER_SIZE);
      expect(declaredLength).toBe(jsonBytes.length);

      const parser = new FrameParser();
      parser.setLegacyMode(true);
      const [parsed] = parser.push(frame);
      expect(parsed).toEqual(envelope);
    });

    it('rejects oversized frames', () => {
      const oversize = 'x'.repeat(MAX_FRAME_BYTES + 1);
      const envelope: Envelope = {
        v: 1,
        type: 'PING',
        id: 'test-oversize',
        ts: 1,
        payload: { nonce: oversize },
      };

      expect(() => encodeFrameLegacy(envelope)).toThrow(/Frame too large/);
    });

    it('handles multiple frames in sequence', () => {
      const parser = new FrameParser();
      parser.setLegacyMode(true);

      const envelope1: Envelope = { v: 1, type: 'PING', id: '1', ts: 1, payload: {} };
      const envelope2: Envelope = { v: 1, type: 'PONG', id: '2', ts: 2, payload: {} };

      const frame1 = encodeFrameLegacy(envelope1);
      const frame2 = encodeFrameLegacy(envelope2);

      // Send both frames at once
      const combined = Buffer.concat([frame1, frame2]);
      const parsed = parser.push(combined);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual(envelope1);
      expect(parsed[1]).toEqual(envelope2);
    });

    it('handles partial frames (streaming)', () => {
      const parser = new FrameParser();
      parser.setLegacyMode(true);

      const envelope: Envelope = { v: 1, type: 'PING', id: 'stream-test', ts: 1, payload: {} };
      const frame = encodeFrameLegacy(envelope);

      // Send first half
      const half = Math.floor(frame.length / 2);
      let parsed = parser.push(frame.subarray(0, half));
      expect(parsed).toHaveLength(0); // Not complete yet

      // Send second half
      parsed = parser.push(frame.subarray(half));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(envelope);
    });
  });

  describe('new format (5-byte header with format indicator)', () => {
    it('roundtrips an envelope with JSON format', () => {
      const envelope: Envelope = {
        v: 1,
        type: 'SEND',
        id: 'new-format-test',
        ts: Date.now(),
        to: 'Agent',
        payload: { kind: 'message', body: 'Hello' },
      };

      const frame = encodeFrame(envelope, 'json');

      // New format: 1 byte format + 4 bytes length
      expect(frame.readUInt8(0)).toBe(0); // 0 = JSON
      const declaredLength = frame.readUInt32BE(1);
      const jsonBytes = frame.subarray(HEADER_SIZE);
      expect(declaredLength).toBe(jsonBytes.length);

      const parser = new FrameParser();
      // Default is new format (legacy = false)
      const [parsed] = parser.push(frame);
      expect(parsed).toEqual(envelope);
    });

    it('handles multiple new format frames', () => {
      const parser = new FrameParser();

      const envelopes: Envelope[] = [
        { v: 1, type: 'PING', id: '1', ts: 1, payload: {} },
        { v: 1, type: 'PONG', id: '2', ts: 2, payload: {} },
        { v: 1, type: 'SEND', id: '3', ts: 3, to: 'Bob', payload: { kind: 'message', body: 'Hi' } },
      ];

      const frames = envelopes.map((e) => encodeFrame(e, 'json'));
      const combined = Buffer.concat(frames);

      const parsed = parser.push(combined);
      expect(parsed).toHaveLength(3);
      expect(parsed).toEqual(envelopes);
    });
  });

  describe('FrameParser ring buffer', () => {
    it('handles many small messages efficiently', () => {
      const parser = new FrameParser();
      parser.setLegacyMode(true);

      const envelope: Envelope = { v: 1, type: 'PING', id: 'x', ts: 1, payload: {} };
      const frame = encodeFrameLegacy(envelope);

      // Process 1000 messages
      let totalParsed = 0;
      for (let i = 0; i < 1000; i++) {
        const parsed = parser.push(frame);
        totalParsed += parsed.length;
      }

      expect(totalParsed).toBe(1000);
    });

    it('reports pending bytes correctly', () => {
      const parser = new FrameParser();
      parser.setLegacyMode(true);

      expect(parser.pendingBytes).toBe(0);

      // Send partial header
      const partialHeader = Buffer.alloc(2);
      partialHeader.writeUInt16BE(0, 0);
      parser.push(partialHeader);

      expect(parser.pendingBytes).toBe(2);

      // Reset should clear
      parser.reset();
      expect(parser.pendingBytes).toBe(0);
    });
  });
});
