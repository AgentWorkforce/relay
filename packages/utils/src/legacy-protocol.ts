/**
 * Minimal legacy protocol types and framing helpers used by utils/client-helpers.
 * These are kept local so utils no longer depends on the removed protocol package.
 */

export const PROTOCOL_VERSION = 1;

export type MessageType =
  | 'HELLO'
  | 'WELCOME'
  | 'SEND'
  | 'DELIVER'
  | 'ACK'
  | 'NACK'
  | 'PING'
  | 'PONG'
  | 'ERROR'
  | 'BUSY'
  | 'RESUME'
  | 'BYE'
  | 'STATE'
  | 'SYNC'
  | 'SYNC_SNAPSHOT'
  | 'SYNC_DELTA'
  | 'SUBSCRIBE'
  | 'UNSUBSCRIBE'
  | 'SHADOW_BIND'
  | 'SHADOW_UNBIND'
  | 'LOG'
  | 'CHANNEL_JOIN'
  | 'CHANNEL_LEAVE'
  | 'CHANNEL_MESSAGE'
  | 'CHANNEL_INFO'
  | 'CHANNEL_MEMBERS'
  | 'CHANNEL_TYPING'
  | 'SPAWN'
  | 'SPAWN_RESULT'
  | 'RELEASE'
  | 'RELEASE_RESULT'
  | 'SEND_INPUT'
  | 'SEND_INPUT_RESULT'
  | 'SET_MODEL'
  | 'SET_MODEL_RESULT'
  | 'LIST_WORKERS'
  | 'LIST_WORKERS_RESULT'
  | 'AGENT_READY'
  | 'STATUS'
  | 'STATUS_RESPONSE'
  | 'INBOX'
  | 'INBOX_RESPONSE'
  | 'LIST_AGENTS'
  | 'LIST_AGENTS_RESPONSE'
  | 'LIST_CONNECTED_AGENTS'
  | 'LIST_CONNECTED_AGENTS_RESPONSE'
  | 'REMOVE_AGENT'
  | 'REMOVE_AGENT_RESPONSE'
  | 'HEALTH'
  | 'HEALTH_RESPONSE'
  | 'METRICS'
  | 'METRICS_RESPONSE'
  | 'MESSAGES_QUERY'
  | 'MESSAGES_RESPONSE'
  | 'PROPOSAL_CREATE'
  | 'VOTE';

export interface Envelope<T = unknown> {
  v: number;
  type: MessageType;
  id: string;
  ts: number;
  from?: string;
  to?: string | '*';
  topic?: string;
  payload: T;
}

export interface AckPayload {
  ack_id: string;
  seq: number;
  cumulative_seq?: number;
  sack?: number[];
  correlationId?: string;
  response?: string;
  responseData?: unknown;
}

export interface SpawnResultPayload {
  replyTo: string;
  success: boolean;
  name: string;
  pid?: number;
  error?: string;
}

export interface ReleaseResultPayload {
  replyTo: string;
  success: boolean;
  name: string;
  error?: string;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const LEGACY_HEADER_SIZE = 4;

export function encodeFrameLegacy(envelope: Envelope): Buffer {
  const data = Buffer.from(JSON.stringify(envelope), 'utf-8');
  if (data.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame too large: ${data.length} > ${MAX_FRAME_BYTES}`);
  }

  const header = Buffer.alloc(LEGACY_HEADER_SIZE);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, data]);
}

export class FrameParser {
  private buffer = Buffer.alloc(0);
  private legacyMode = false;

  setLegacyMode(legacy: boolean): void {
    this.legacyMode = legacy;
  }

  push(data: Buffer): Envelope[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: Envelope[] = [];
    const headerSize = this.legacyMode ? LEGACY_HEADER_SIZE : 5;

    while (this.buffer.length >= headerSize) {
      const length = this.legacyMode ? this.buffer.readUInt32BE(0) : this.buffer.readUInt32BE(1);

      if (length > MAX_FRAME_BYTES) {
        throw new Error(`Frame too large: ${length} > ${MAX_FRAME_BYTES}`);
      }

      const total = headerSize + length;
      if (this.buffer.length < total) break;

      const payloadStart = headerSize;
      const payloadEnd = total;
      const payloadBuf = this.buffer.subarray(payloadStart, payloadEnd);
      const envelope = JSON.parse(payloadBuf.toString('utf-8')) as Envelope;
      frames.push(envelope);
      this.buffer = this.buffer.subarray(total);
    }

    return frames;
  }
}
