import { AgentRelayClient, AgentRelayProtocolError } from '@agent-relay/sdk';

import type { BrokerConnection } from './broker-connection.js';

export function createBrokerClient(
  connection: BrokerConnection,
  fetchFn?: typeof globalThis.fetch
): AgentRelayClient {
  return new AgentRelayClient({
    baseUrl: connection.url,
    apiKey: connection.apiKey,
    fetch: fetchFn,
  });
}

export interface BrokerSdkFailure {
  status: number;
  message: string;
}

export function mapBrokerSdkFailure(error: unknown): BrokerSdkFailure {
  if (error instanceof AgentRelayProtocolError) {
    return {
      status: error.status ?? parseHttpStatus(error.code) ?? 0,
      message: error.message,
    };
  }
  return {
    status: 0,
    message: error instanceof Error ? error.message : String(error),
  };
}

function parseHttpStatus(code: string): number | undefined {
  const match = /^http_(\d{3})$/.exec(code);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : undefined;
}
