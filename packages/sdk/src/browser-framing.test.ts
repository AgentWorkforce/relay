import { describe, it, expect } from 'vitest';
import { encodeFrameLegacyBrowser, BrowserFrameParser } from './browser-framing.js';

describe('browser-framing', () => {
  describe('encodeFrameLegacyBrowser', () => {
    it('encodes envelope with 4-byte length header', () => {
      const envelope = { type: 'PING', v: 1, id: 'test', ts: 12345, payload: {} };
      const frame = encodeFrameLegacyBrowser(envelope);

      // Should be Uint8Array
      expect(frame).toBeInstanceOf(Uint8Array);

      // First 4 bytes should be the length in big-endian
      const view = new DataView(frame.buffer);
      const length = view.getUint32(0, false);

      // Payload should match the encoded JSON length
      const json = JSON.stringify(envelope);
      expect(length).toBe(new TextEncoder().encode(json).length);
    });

    it('throws on oversized frames', () => {
      const largePayload = 'x'.repeat(1024 * 1024 + 1);
      const envelope = { type: 'SEND', v: 1, id: 'test', ts: 12345, payload: { body: largePayload } };

      expect(() => encodeFrameLegacyBrowser(envelope)).toThrow(/Frame too large/);
    });
  });

  describe('BrowserFrameParser', () => {
    it('parses complete frame', () => {
      const envelope = { type: 'PONG', v: 1, id: 'abc', ts: 999, payload: {} };
      const frame = encodeFrameLegacyBrowser(envelope);

      const parser = new BrowserFrameParser();
      const parsed = parser.push(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(envelope);
    });

    it('handles partial frames', () => {
      const envelope = { type: 'SEND', v: 1, id: 'xyz', ts: 1000, payload: { to: 'Agent', body: 'Hello' } };
      const frame = encodeFrameLegacyBrowser(envelope);

      const parser = new BrowserFrameParser();

      // Send first half
      const half = Math.floor(frame.length / 2);
      let parsed = parser.push(frame.subarray(0, half));
      expect(parsed).toHaveLength(0);

      // Send second half
      parsed = parser.push(frame.subarray(half));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(envelope);
    });

    it('parses multiple frames in sequence', () => {
      const envelopes = [
        { type: 'PING', v: 1, id: '1', ts: 1, payload: {} },
        { type: 'PONG', v: 1, id: '2', ts: 2, payload: {} },
        { type: 'ACK', v: 1, id: '3', ts: 3, payload: { messageId: 'x' } },
      ];

      const frames = envelopes.map(e => encodeFrameLegacyBrowser(e));
      const combined = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0));
      let offset = 0;
      for (const frame of frames) {
        combined.set(frame, offset);
        offset += frame.length;
      }

      const parser = new BrowserFrameParser();
      const parsed = parser.push(combined);

      expect(parsed).toHaveLength(3);
      expect(parsed).toEqual(envelopes);
    });

    it('tracks pending bytes correctly', () => {
      const parser = new BrowserFrameParser();
      expect(parser.pendingBytes).toBe(0);

      // Push partial header
      parser.push(new Uint8Array([0, 0, 0, 10])); // Header claiming 10 byte payload
      expect(parser.pendingBytes).toBe(4);

      // Push partial payload
      parser.push(new Uint8Array([123])); // Just '{'
      expect(parser.pendingBytes).toBe(5);
    });

    it('throws on oversized frame', () => {
      const parser = new BrowserFrameParser();

      // Create header claiming 2MB payload
      const header = new Uint8Array(4);
      const view = new DataView(header.buffer);
      view.setUint32(0, 2 * 1024 * 1024, false);

      expect(() => parser.push(header)).toThrow(/Frame too large/);
    });

    it('resets parser state', () => {
      const parser = new BrowserFrameParser();
      parser.push(new Uint8Array([0, 0, 0, 5, 123])); // Partial frame

      expect(parser.pendingBytes).toBeGreaterThan(0);

      parser.reset();
      expect(parser.pendingBytes).toBe(0);
    });
  });
});
