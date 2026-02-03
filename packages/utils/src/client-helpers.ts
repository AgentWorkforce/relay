/**
 * Shared client helpers for SDK and MCP implementations
 *
 * This module provides common request/response handling and type aliases
 * to ensure SDK and MCP clients stay in lockstep and avoid inconsistencies.
 */

import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  type Envelope,
  type MessageType,
  type AckPayload,
  type SpawnResultPayload,
  type ReleaseResultPayload,
  encodeFrameLegacy,
  FrameParser,
  PROTOCOL_VERSION,
} from '@agent-relay/protocol';

/**
 * Common return type aliases to ensure consistency between SDK and MCP
 */
export type SpawnResult = {
  success: boolean;
  error?: string;
  pid?: number;
  name?: string;
};

export type ReleaseResult = {
  success: boolean;
  error?: string;
  name?: string;
};

/**
 * Options for request/response operations
 */
export interface RequestOptions {
  /** Custom timeout in milliseconds */
  timeoutMs?: number;
  /** Payload metadata (for sync operations) */
  payloadMeta?: {
    sync?: {
      blocking?: boolean;
      correlationId?: string;
      timeoutMs?: number;
    };
  };
  /** Envelope properties (from/to) */
  envelopeProps?: {
    from?: string;
    to?: string;
  };
}

/**
 * Response matching logic for request/response operations
 */
export function isMatchingResponse(
  response: Envelope,
  requestId: string,
  correlationId?: string
): boolean {
  const responsePayload = response.payload as {
    replyTo?: string;
    correlationId?: string;
  };

  // For ACK messages, match by correlationId
  const ackPayload = response.type === 'ACK' ? (response.payload as AckPayload) : null;

  return (
    response.id === requestId ||
    responsePayload?.replyTo === requestId ||
    (!!correlationId &&
      (responsePayload?.correlationId === correlationId ||
        ackPayload?.correlationId === correlationId))
  );
}

/**
 * Handle response resolution/rejection logic
 */
export function handleResponse<T>(
  response: Envelope,
  resolve: (value: T) => void,
  reject: (error: Error) => void
): void {
  const responsePayload = response.payload as {
    error?: string;
    message?: string;
    code?: string;
    success?: boolean;
  };

  if (response.type === 'ERROR') {
    reject(
      new Error(responsePayload?.message || responsePayload?.code || 'Unknown error')
    );
  } else if (
    response.type === 'ACK' ||
    response.type === 'SPAWN_RESULT' ||
    response.type === 'RELEASE_RESULT'
  ) {
    // ACK, SPAWN_RESULT, and RELEASE_RESULT are valid responses even if they contain error info
    // For ACK, the error is in response field; for spawn/release, it's in error field
    resolve(response.payload as T);
  } else if (responsePayload?.error && !responsePayload?.success) {
    // For other response types, reject if there's an error and no success flag
    reject(new Error(responsePayload.error));
  } else {
    resolve(response.payload as T);
  }
}

/**
 * Create a request envelope
 */
export function createRequestEnvelope(
  type: MessageType,
  payload: Record<string, unknown>,
  requestId: string,
  options?: RequestOptions
): Envelope {
  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    type,
    id: requestId,
    ts: Date.now(),
    payload,
    from: options?.envelopeProps?.from,
    to: options?.envelopeProps?.to,
  };

  if (options?.payloadMeta) {
    (envelope as unknown as Record<string, unknown>).payload_meta =
      options.payloadMeta;
  }

  return envelope;
}

/**
 * Convert SpawnResultPayload to SpawnResult
 */
export function toSpawnResult(payload: SpawnResultPayload): SpawnResult {
  return {
    success: payload.success,
    error: payload.error,
    pid: payload.pid,
    name: payload.name,
  };
}

/**
 * Convert ReleaseResultPayload to ReleaseResult
 */
export function toReleaseResult(payload: ReleaseResultPayload): ReleaseResult {
  return {
    success: payload.success,
    error: payload.error,
    name: payload.name,
  };
}

/**
 * Create a request/response handler using a socket connection
 * This is the core logic shared between SDK and MCP clients
 */
export function createRequestHandler<T>(
  socketPath: string,
  envelope: Envelope,
  options: RequestOptions & { timeout: number }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const correlationId = options.payloadMeta?.sync?.correlationId;
    let timedOut = false;
    const parser = new FrameParser();
    parser.setLegacyMode(true); // Use legacy 4-byte header format

    const socket: Socket = createConnection(socketPath);

    const timeoutId = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      reject(new Error(`Request timeout after ${options.timeout}ms`));
    }, options.timeout);

    socket.on('connect', () => {
      socket.write(encodeFrameLegacy(envelope));
    });

    socket.on('data', (data) => {
      if (timedOut) return;

      const frames = parser.push(data);
      for (const response of frames) {
        if (isMatchingResponse(response, envelope.id, correlationId)) {
          clearTimeout(timeoutId);
          socket.end();
          handleResponse(response, resolve, reject);
          return;
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
