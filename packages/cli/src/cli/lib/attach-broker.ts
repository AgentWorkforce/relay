import { HarnessDriverClient } from '@agent-relay/harness-driver';

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
} from '@agent-relay/harness-driver';

/**
 * Build the broker client for the interactive attach clients. This is the
 * single place the CLI turns a {@link BrokerConnection} into a
 * {@link HarnessDriverClient}, so every `runtime`/attach command reaches the broker
 * through `@agent-relay/harness-driver` — including the real WebSocket PTY input
 * stream exposed by `HarnessDriverClient.openInputStream`.
 */
export function createBrokerClient(
  connection: BrokerConnection,
  fetchFn?: typeof globalThis.fetch
): HarnessDriverClient {
  return new HarnessDriverClient({ baseUrl: connection.url, apiKey: connection.apiKey, fetch: fetchFn });
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
