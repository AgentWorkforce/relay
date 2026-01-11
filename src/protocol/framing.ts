/**
 * Frame encoding/decoding for the agent relay protocol.
 *
 * Wire format:
 * - 1 byte: format indicator (0 = JSON, 1 = MessagePack)
 * - 4 bytes: big-endian payload length
 * - N bytes: payload (JSON or MessagePack encoded)
 *
 * Optimizations:
 * - Ring buffer to avoid Buffer.concat allocations
 * - MessagePack support for faster serialization (optional)
 * - Zero-copy frame extraction where possible
 */

import type { Envelope } from './types.js';

export const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB default
export const HEADER_SIZE = 5; // 1 byte format + 4 bytes length
export const LEGACY_HEADER_SIZE = 4; // For backwards compatibility

export type WireFormat = 'json' | 'msgpack';

// Format indicator bytes
const FORMAT_JSON = 0;
const FORMAT_MSGPACK = 1;

// Optional MessagePack - loaded dynamically if available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let msgpack: { encode: (obj: unknown) => Uint8Array; decode: (buf: Uint8Array) => unknown } | null = null;

/**
 * Initialize MessagePack support. Call this at startup if you want msgpack.
 * Install @msgpack/msgpack to enable: npm install @msgpack/msgpack
 */
export async function initMessagePack(): Promise<boolean> {
  if (msgpack) return true; // Already initialized

  try {
    // Dynamic import to avoid compile-time dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('@msgpack/msgpack' as any) as any;
    const encode = mod.encode || mod.default?.encode;
    const decode = mod.decode || mod.default?.decode;
    if (encode && decode) {
      msgpack = { encode, decode };
      return true;
    }
    return false;
  } catch {
    // MessagePack not installed, JSON-only mode
    return false;
  }
}

/**
 * Check if MessagePack is available.
 */
export function hasMessagePack(): boolean {
  return msgpack !== null;
}

/**
 * Encode a message envelope into a framed buffer.
 *
 * @param envelope - The envelope to encode
 * @param format - Wire format to use (default: 'json')
 * @returns Framed buffer ready for socket write
 */
export function encodeFrame(envelope: Envelope, format: WireFormat = 'json'): Buffer {
  let data: Buffer;
  let formatByte: number;

  if (format === 'msgpack' && msgpack) {
    // MessagePack: more compact, faster
    const encoded = msgpack.encode(envelope);
    data = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    formatByte = FORMAT_MSGPACK;
  } else {
    // JSON: human-readable, always available
    data = Buffer.from(JSON.stringify(envelope), 'utf-8');
    formatByte = FORMAT_JSON;
  }

  if (data.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame too large: ${data.length} > ${MAX_FRAME_BYTES}`);
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(formatByte, 0);
  header.writeUInt32BE(data.length, 1);

  return Buffer.concat([header, data]);
}

/**
 * Encode a frame in legacy format (no format byte, JSON only).
 * Used for backwards compatibility with older clients.
 */
export function encodeFrameLegacy(envelope: Envelope): Buffer {
  const json = JSON.stringify(envelope);
  const data = Buffer.from(json, 'utf-8');

  if (data.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame too large: ${data.length} > ${MAX_FRAME_BYTES}`);
  }

  const header = Buffer.alloc(LEGACY_HEADER_SIZE);
  header.writeUInt32BE(data.length, 0);

  return Buffer.concat([header, data]);
}

/**
 * Ring buffer-based frame parser for streaming data.
 *
 * Optimizations:
 * - Pre-allocated buffer avoids GC pressure from Buffer.concat
 * - Compaction only when necessary (wrap-around)
 * - Direct parsing from buffer offsets
 */
export class FrameParser {
  private ring: Buffer;
  private head = 0; // Read position
  private tail = 0; // Write position
  private readonly capacity: number;
  private readonly maxFrameBytes: number;
  private format: WireFormat = 'json';
  private legacyMode = false; // Auto-detect legacy clients

  constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
    // Allocate 2x max frame for ring buffer headroom
    this.capacity = maxFrameBytes * 2 + HEADER_SIZE;
    this.ring = Buffer.allocUnsafe(this.capacity);
  }

  /**
   * Set the expected wire format for parsing.
   */
  setFormat(format: WireFormat): void {
    this.format = format;
  }

  /**
   * Enable legacy mode (4-byte header, JSON only).
   */
  setLegacyMode(legacy: boolean): void {
    this.legacyMode = legacy;
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
   * @param data - Incoming data buffer
   * @returns Array of parsed envelope frames
   */
  push(data: Buffer): Envelope[] {
    // Check if we have room at the end
    const spaceAtEnd = this.capacity - this.tail;

    if (data.length > spaceAtEnd) {
      // Need to compact: shift unread data to start
      this.compact();

      // Check again after compaction
      if (data.length > this.capacity - this.tail) {
        throw new Error(`Buffer overflow: data ${data.length} exceeds capacity`);
      }
    }

    // Copy incoming data to ring buffer (single copy, no concat)
    data.copy(this.ring, this.tail);
    this.tail += data.length;

    // Extract complete frames
    return this.extractFrames();
  }

  /**
   * Extract all complete frames from the buffer.
   */
  private extractFrames(): Envelope[] {
    const frames: Envelope[] = [];
    const headerSize = this.legacyMode ? LEGACY_HEADER_SIZE : HEADER_SIZE;

    while (this.pendingBytes >= headerSize) {
      // Read frame metadata
      let formatByte = FORMAT_JSON;
      let frameLength: number;

      if (this.legacyMode) {
        frameLength = this.ring.readUInt32BE(this.head);
      } else {
        formatByte = this.ring.readUInt8(this.head);
        frameLength = this.ring.readUInt32BE(this.head + 1);
      }

      // Validate frame size
      if (frameLength > this.maxFrameBytes) {
        throw new Error(`Frame too large: ${frameLength} > ${this.maxFrameBytes}`);
      }

      const totalLength = headerSize + frameLength;

      // Check if we have the complete frame
      if (this.pendingBytes < totalLength) {
        break; // Need more data
      }

      // Extract and parse the frame
      const payloadStart = this.head + headerSize;
      const payloadEnd = this.head + totalLength;

      let envelope: Envelope;
      try {
        envelope = this.decodePayload(formatByte, payloadStart, payloadEnd);
      } catch (err) {
        throw new Error(`Invalid frame payload: ${err}`);
      }

      // Advance read position
      this.head += totalLength;
      frames.push(envelope);
    }

    // Opportunistic compaction if we've consumed most of the buffer
    if (this.head > this.capacity / 2 && this.pendingBytes < this.capacity / 4) {
      this.compact();
    }

    return frames;
  }

  /**
   * Decode payload based on format byte.
   */
  private decodePayload(formatByte: number, start: number, end: number): Envelope {
    if (formatByte === FORMAT_MSGPACK && msgpack) {
      // MessagePack decode
      return msgpack.decode(this.ring.subarray(start, end)) as Envelope;
    } else {
      // JSON decode (default)
      return JSON.parse(this.ring.toString('utf-8', start, end)) as Envelope;
    }
  }

  /**
   * Compact the buffer by shifting unread data to the start.
   */
  private compact(): void {
    if (this.head === 0) return;

    const unread = this.pendingBytes;
    if (unread > 0) {
      // Copy unread data to start of buffer
      this.ring.copy(this.ring, 0, this.head, this.tail);
    }
    this.head = 0;
    this.tail = unread;
  }

  /**
   * Reset parser state (e.g., on connection reset).
   */
  reset(): void {
    this.head = 0;
    this.tail = 0;
  }
}
