import { createHash } from 'node:crypto';

export const BROKER_NAME = 'relayflow-inventory-ack';
export const BROKER_TYPE = 'human';
// Synthetic isolated-fixture identity, never a real workspace credential.
export const BROKER_IDENTITY = 'relayflow-inventory-ack-fixture-identity';
export const BROKER_IDENTITY_HASH = createHash('sha256').update(BROKER_IDENTITY).digest('hex');

/** Validate the HTTP bootstrap independently of the WebSocket liveness oracle. */
export function brokerHttpResponse(method, pathname, body) {
  if (method !== 'POST' || pathname !== '/v1/agents') {
    return {
      status: 404,
      body: { ok: false, error: { code: 'fixture_route_not_found', message: 'Unexpected fixture route' } },
    };
  }
  if (
    body?.name !== BROKER_NAME ||
    body?.type !== BROKER_TYPE ||
    body?.metadata?.identity_key !== BROKER_IDENTITY_HASH
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'fixture_registration_invalid',
          message: 'Unexpected registration name, type, or identity metadata',
        },
      },
    };
  }
  return {
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
  };
}
