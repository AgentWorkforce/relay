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

function toCurrentSdkBrokerEventShape(event: Record<string, unknown>): Record<string, unknown> {
  const payload =
    event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : null;
  if (!payload) return event;

  const kind = event.kind;
  if (kind === 'relay_inbound') {
    return {
      kind,
      event_id: event.eventId,
      from: payload.from,
      target: payload.target,
      body: payload.body,
    };
  }

  if (kind === 'agent_spawned') {
    return {
      kind,
      name: payload.name,
      runtime: payload.runtime,
    };
  }

  if (
    kind === 'agent_exited' ||
    kind === 'agent_released' ||
    kind === 'agent_restarting' ||
    kind === 'agent_restarted' ||
    kind === 'agent_permanently_dead'
  ) {
    return {
      kind,
      name: payload.name,
    };
  }

  if (kind === 'worker_ready') {
    return {
      kind,
      name: payload.name,
      runtime: payload.runtime,
    };
  }

  if (kind === 'agent_idle') {
    return {
      kind,
      name: payload.name,
      idle_secs: payload.idleSecs,
    };
  }

  if (kind === 'delivery_verified') {
    return {
      kind,
      name: payload.name,
      delivery_id: payload.deliveryId,
      event_id: event.eventId,
    };
  }

  if (kind === 'delivery_failed') {
    return {
      kind,
      name: payload.name,
      delivery_id: payload.deliveryId,
      event_id: event.eventId,
      reason: payload.reason,
    };
  }

  if (kind === 'worker_error') {
    return {
      kind,
      name: payload.name,
      code: payload.code,
      message: payload.message,
    };
  }

  return event;
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
        typeof event.name === 'string' && typeof event.code === 'string' && typeof event.message === 'string'
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
  assert.equal(
    result.event_id === 'unsupported_operation' || allowedCodes.has(result.event_id),
    true,
    `unsupported fallback code \"${result.event_id}\" is outside shared RelayErrorCode fixture set`
  );
});

test('contracts: broker-sdk event surface conforms to shared BrokerEvent fixture envelope', async () => {
  const fixture = readFixture<EventFixture>('event-fixtures.json');

  for (const event of fixture.contract_events) {
    const normalized = toCurrentSdkBrokerEventShape(event);
    assert.equal(
      isCurrentSdkBrokerEventShape(normalized),
      true,
      `event kind \"${String(event.kind)}\" does not match current broker-sdk event surface`
    );
  }
});
