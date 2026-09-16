import { describe, expect, it } from 'vitest';
import {
  BROKER_NAME,
  BROKER_TYPE,
  BROKER_IDENTITY_HASH,
  brokerHttpResponse,
} from '../relayflows/cases/1591-application-ack-reconnect/http-fixture.mjs';

const registration = () => ({
  name: BROKER_NAME,
  type: BROKER_TYPE,
  metadata: { identity_key: BROKER_IDENTITY_HASH },
});

describe('inventory liveness HTTP fixture (unit only)', () => {
  it('preserves the valid broker registration response', () => {
    expect(brokerHttpResponse('POST', '/v1/agents', registration())).toEqual({
      status: 200,
      body: {
        ok: true,
        data: {
          id: 'agent_proof_broker',
          workspace_id: 'ws_proof',
          name: BROKER_NAME,
          token: 'at_proof',
          status: 'active',
          created_at: '2026-09-14T00:00:00Z',
        },
      },
    });
  });
  it.each([
    null,
    {},
    { ...registration(), name: 'wrong' },
    { ...registration(), type: 'agent' },
    { ...registration(), metadata: {} },
    { ...registration(), metadata: { identity_key: 'wrong' } },
  ])('rejects invalid registration %j', (body) => {
    expect(brokerHttpResponse('POST', '/v1/agents', body)).toMatchObject({
      status: 400,
      body: { ok: false, error: { code: 'fixture_registration_invalid' } },
    });
  });
  it.each([
    ['GET', '/v1/agents'],
    ['POST', '/v1/agent'],
    ['PATCH', '/v1/agents/worker'],
  ])('rejects unexpected route %s %s', (method, route) => {
    expect(brokerHttpResponse(method, route, registration())).toMatchObject({
      status: 404,
      body: { ok: false },
    });
  });
});
