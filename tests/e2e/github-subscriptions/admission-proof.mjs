import assert from 'node:assert/strict';

/** Transparent observer: retain response metadata, never headers or provider payloads. */
export function observeEnvelopeAdmissions(fetchImpl, endpoint, record) {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (input !== endpoint || typeof init?.body !== 'string') return response;
    const envelope = JSON.parse(init.body);
    let errorCode;
    if (response.status === 409) {
      const body = await response.clone().json();
      errorCode = body.code ?? body.error?.code;
    }
    record({
      at: new Date().toISOString(),
      envelopeId: envelope.envelopeId,
      deliveryId: envelope.deliveryId,
      status: response.status,
      ...(errorCode ? { errorCode } : {}),
    });
    return response;
  };
}

export function assertDuplicateAdmission(rows, deliveryId) {
  const original = rows.find((r) => r.deliveryId === deliveryId && r.status >= 200 && r.status < 300);
  const duplicate = rows.find(
    (r) => r.deliveryId === deliveryId && r.status === 409 && r.errorCode === 'duplicate_envelope'
  );
  assert(
    original && duplicate && original.envelopeId === duplicate.envelopeId,
    'Prejoin redelivery must be rejected as the same duplicate envelope before worker startup'
  );
  return { envelopeId: duplicate.envelopeId, status: duplicate.status, code: duplicate.errorCode };
}

export function assertNoStalePrejoinAction(messages, actorId, digest) {
  assert(
    !messages.some((m) => m.agent_id === actorId && m.text?.includes(digest)),
    'Stale prejoin event replayed'
  );
}
