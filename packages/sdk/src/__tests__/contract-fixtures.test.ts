import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AgentRelayClient, AgentRelayProtocolError } from '../client.js';

type RelayErrorFixture = {
  relay_errors: Array<{ code: string; message: string; retryable: boolean; statusCode?: number }>;
};

type EventFixture = {
  contract_events: Array<Record<string, unknown>>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '../../../contracts/fixtures');

function readFixture<T>(name: string): T {
  const fixturePath = path.join(fixturesDir, name);
  const raw = fs.readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as T;
}

function isCurrentSdkBrokerEventShape(event: Record<string, unknown>): boolean {
  const kind = event.kind;
  if (typeof kind !== 'string') return false;

  switch (kind) {
    case 'relay_inbound':
      return (
        typeof event.event_id === 'string' &&
        typeof event.from === 'string' &&
        typeof event.target === 'string' &&
        typeof event.body === 'string'
      );
    case 'agent_spawned':
      return typeof event.name === 'string' && typeof event.runtime === 'string';
    case 'agent_exited':
      return typeof event.name === 'string';
    case 'agent_released':
      return typeof event.name === 'string';
    case 'worker_ready':
      return typeof event.name === 'string' && typeof event.runtime === 'string';
    case 'agent_idle':
      return typeof event.name === 'string' && typeof event.idle_secs === 'number';
    case 'delivery_verified':
      return (
        typeof event.name === 'string' &&
        typeof event.delivery_id === 'string' &&
        typeof event.event_id === 'string'
      );
    case 'delivery_failed':
      return (
        typeof event.name === 'string' &&
        typeof event.delivery_id === 'string' &&
        typeof event.event_id === 'string' &&
        typeof event.reason === 'string'
      );
    case 'worker_error':
      return (
        typeof event.name === 'string' &&
        typeof event.code === 'string' &&
        typeof event.message === 'string'
      );
    case 'agent_restarting':
    case 'agent_restarted':
    case 'agent_permanently_dead':
      return typeof event.name === 'string';
    default:
      return false;
  }
}

test('contracts: broker-sdk unsupported_operation fallback maps to shared RelayErrorCode set', async () => {
  const fixture = readFixture<RelayErrorFixture>('error-fixtures.json');
  const allowedCodes = new Set(fixture.relay_errors.map((entry) => entry.code));

  const client = new AgentRelayClient();
  (client as unknown as { start: () => Promise<void> }).start = async () => undefined;
  (
    client as unknown as {
      requestOk: () => Promise<never>;
    }
  ).requestOk = async () => {
    throw new AgentRelayProtocolError({
      code: 'unsupported_operation',
      message: 'send_message unsupported',
      retryable: false,
    });
  };

  const result = await client.sendMessage({
    to: 'WorkerA',
    text: 'contract-gate probe',
  });

  assert.equal(result.event_id, 'unsupported_operation');
  // TODO(contract-wave1-error-codes): broker-sdk fallback sentinel should align
  // with shared RelayErrorCode contracts, or be mapped before surface exposure.
  assert.equal(
    allowedCodes.has(result.event_id),
    true,
    `unsupported fallback code \"${result.event_id}\" is outside shared RelayErrorCode fixture set`
  );
});

test('contracts: broker-sdk event surface conforms to shared BrokerEvent fixture envelope', async () => {
  const fixture = readFixture<EventFixture>('event-fixtures.json');

  for (const event of fixture.contract_events) {
    // TODO(contract-wave1-event-envelope): broker-sdk should consume/emit the
    // shared envelope shape (eventId/seq/timestamp/payload) from contracts fixtures.
    assert.equal(
      isCurrentSdkBrokerEventShape(event),
      true,
      `event kind \"${String(event.kind)}\" does not match current broker-sdk event surface`
    );
  }
});
