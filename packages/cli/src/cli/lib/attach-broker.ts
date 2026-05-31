import {
  RuntimeClient,
  type InboundDeliveryMode,
  type PendingRelayMessage,
  type PtySnapshot,
  type SetInboundDeliveryModeResult,
  type SnapshotFormat,
} from '@agent-relay/runtime';

import type { BrokerConnection } from './broker-connection.js';

export interface PtyInputStreamOptions {
  onClose?: (code?: number, reason?: string) => void;
}

export interface PtyInputWriteResult {
  ok: boolean;
  bytesWritten?: number;
}

/** Interactive PTY input stream used by `drive`/`passthrough`. */
export interface CliPtyInputStream {
  waitUntilOpen(): Promise<void>;
  send(data: string): Promise<PtyInputWriteResult>;
  close(code?: number, reason?: string): void;
}

/** Broker surface the interactive attach clients depend on. */
export interface BrokerClient {
  getInboundDeliveryMode(name: string): Promise<InboundDeliveryMode>;
  setInboundDeliveryMode(name: string, mode: InboundDeliveryMode): Promise<SetInboundDeliveryModeResult>;
  getPending(name: string): Promise<PendingRelayMessage[]>;
  flushPending(name: string): Promise<{ flushed: number }>;
  sendInput(name: string, data: string): Promise<{ name: string; bytes_written: number }>;
  resizePty(name: string, rows: number, cols: number): Promise<{ name: string; rows: number; cols: number }>;
  snapshot(name: string, format?: SnapshotFormat): Promise<PtySnapshot>;
  openInputStream(name: string, options?: PtyInputStreamOptions): CliPtyInputStream;
}

/**
 * Build a broker client backed by {@link RuntimeClient}. The interactive PTY
 * input stream is shimmed over the broker's `sendInput` HTTP endpoint since the
 * runtime client does not expose a long-lived input socket.
 */
export function createBrokerClient(
  connection: BrokerConnection,
  fetchFn?: typeof globalThis.fetch
): BrokerClient {
  const client = new RuntimeClient({ baseUrl: connection.url, apiKey: connection.apiKey, fetch: fetchFn });
  return {
    getInboundDeliveryMode: (name) => client.getInboundDeliveryMode(name),
    setInboundDeliveryMode: (name, mode) => client.setInboundDeliveryMode(name, mode),
    getPending: (name) => client.getPending(name),
    flushPending: (name) => client.flushPending(name),
    sendInput: (name, data) => client.sendInput(name, data),
    resizePty: (name, rows, cols) => client.resizePty(name, rows, cols),
    snapshot: (name, format) => client.snapshot(name, format),
    openInputStream: (name, options) => ({
      waitUntilOpen: async () => {},
      send: async (data) => {
        const result = await client.sendInput(name, data);
        return { ok: true, bytesWritten: result.bytes_written };
      },
      close: (code, reason) => options?.onClose?.(code, reason),
    }),
  };
}

export interface BrokerSdkFailure {
  status: number;
  message: string;
}

export function mapBrokerSdkFailure(error: unknown): BrokerSdkFailure {
  const status =
    error && typeof error === 'object' && 'status' in error && typeof (error as { status: unknown }).status === 'number'
      ? (error as { status: number }).status
      : 0;
  return { status, message: error instanceof Error ? error.message : String(error) };
}
