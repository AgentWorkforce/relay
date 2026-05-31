import { RuntimeClient } from '@agent-relay/runtime';

import type { BrokerConnection } from './broker-connection.js';

export type {
  InboundDeliveryMode,
  PendingRelayMessage,
  PtyInputStream as CliPtyInputStream,
  PtyInputStreamOptions,
  PtyInputWriteResult,
  PtySnapshot,
  SetInboundDeliveryModeResult,
  SnapshotFormat,
} from '@agent-relay/runtime';

/**
 * Build the broker client for the interactive attach clients. This is the
 * single place the CLI turns a {@link BrokerConnection} into a
 * {@link RuntimeClient}, so every `runtime`/attach command reaches the broker
 * through `@agent-relay/runtime` — including the real WebSocket PTY input
 * stream exposed by `RuntimeClient.openInputStream`.
 */
export function createBrokerClient(
  connection: BrokerConnection,
  fetchFn?: typeof globalThis.fetch
): RuntimeClient {
  return new RuntimeClient({ baseUrl: connection.url, apiKey: connection.apiKey, fetch: fetchFn });
}

export interface BrokerSdkFailure {
  status: number;
  message: string;
}

export function mapBrokerSdkFailure(error: unknown): BrokerSdkFailure {
  const status =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
      ? (error as { status: number }).status
      : 0;
  return { status, message: error instanceof Error ? error.message : String(error) };
}
