/**
 * Browser-compatible frame encoding/decoding for the Agent Relay protocol.
 *
 * Uses Uint8Array and DataView instead of Node.js Buffer for browser compatibility.
 *
 * Wire format (legacy):
 * - 4 bytes: big-endian payload length
 * - N bytes: JSON payload
 */

import type { Envelope } from '@agent-relay/protocol';

export const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB
export const LEGACY_HEADER_SIZE = 4;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode a frame in legacy format (4-byte header, JSON only).
 * Browser-compatible version using Uint8Array.
 */
export function encodeFrameLegacyBrowser(envelope: Envelope): Uint8Array {
  const json = JSON.stringify(envelope);
  const data = textEncoder.encode(json);

  if (data.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame too large: ${data.length} > ${MAX_FRAME_BYTES}`);
  }

  const frame = new Uint8Array(LEGACY_HEADER_SIZE + data.length);
  const view = new DataView(frame.buffer);

  // Write 4-byte big-endian length header
  view.setUint32(0, data.length, false);

  // Copy payload
  frame.set(data, LEGACY_HEADER_SIZE);

  return frame;
}

/**
 * Browser-compatible frame parser using Uint8Array and DataView.
 */
export class BrowserFrameParser {
  private buffer: Uint8Array;
  private head = 0;
  private tail = 0;
  private readonly capacity: number;
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
    this.capacity = maxFrameBytes * 2 + LEGACY_HEADER_SIZE;
    this.buffer = new Uint8Array(this.capacity);
  }

  /**
   * Get current unread bytes in buffer.
   */
  get pendingBytes(): number {
    return this.tail - this.head;
  }

  /**
   * Push data into the parser and extract complete frames.
   *
   * @param data - Incoming data as Uint8Array
   * @returns Array of parsed envelope frames
   */
  push(data: Uint8Array): Envelope[] {
    const spaceAtEnd = this.capacity - this.tail;

    if (data.length > spaceAtEnd) {
      this.compact();

      if (data.length > this.capacity - this.tail) {
        throw new Error(`Buffer overflow: data ${data.length} exceeds capacity`);
      }
    }

    // Copy incoming data to buffer
    this.buffer.set(data, this.tail);
    this.tail += data.length;

    return this.extractFrames();
  }

  private extractFrames(): Envelope[] {
    const frames: Envelope[] = [];
    const view = new DataView(this.buffer.buffer);

    while (this.pendingBytes >= LEGACY_HEADER_SIZE) {
      // Read 4-byte big-endian length
      const frameLength = view.getUint32(this.head, false);

      if (frameLength > this.maxFrameBytes) {
        throw new Error(`Frame too large: ${frameLength} > ${this.maxFrameBytes}`);
      }

      const totalLength = LEGACY_HEADER_SIZE + frameLength;

      if (this.pendingBytes < totalLength) {
        break;
      }

      const payloadStart = this.head + LEGACY_HEADER_SIZE;
      const payloadEnd = this.head + totalLength;

      let envelope: Envelope;
      try {
        const payload = this.buffer.subarray(payloadStart, payloadEnd);
        const json = textDecoder.decode(payload);
        envelope = JSON.parse(json) as Envelope;
      } catch (err) {
        throw new Error(`Invalid frame payload: ${err}`);
      }

      this.head += totalLength;
      frames.push(envelope);
    }

    if (this.head > this.capacity / 2 && this.pendingBytes < this.capacity / 4) {
      this.compact();
    }

    return frames;
  }

  private compact(): void {
    if (this.head === 0) return;

    const pending = this.pendingBytes;
    if (pending > 0) {
      // Copy remaining data to start of buffer
      this.buffer.copyWithin(0, this.head, this.tail);
    }
    this.tail = pending;
    this.head = 0;
  }

  /**
   * Reset the parser state.
   */
  reset(): void {
    this.head = 0;
    this.tail = 0;
  }
}
