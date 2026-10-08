import { describe, expect, it, vi } from 'vitest';

import { HarnessDriverClient } from './client.js';

function stubClient(responseBody: unknown) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  ) as unknown as typeof globalThis.fetch;
  return new HarnessDriverClient({ baseUrl: 'http://broker', apiKey: 'secret', fetch });
}

const gapDiagnostics = {
  blocked_reason: 'head fleet sequence 90 is not ACKable; next expected sequence is 89',
  blocked_reason_code: 'missing_predecessor_ack',
  head_sequence: 90,
  acked_up_to_sequence: 88,
  received_up_to_sequence: 90,
  next_ackable_sequence: 89,
  reconciliation_action: 'predecessor_replayed',
};

const parsedGapDiagnostics = {
  blockedReason: gapDiagnostics.blocked_reason,
  blockedReasonCode: gapDiagnostics.blocked_reason_code,
  headSequence: 90,
  ackedUpToSequence: 88,
  receivedUpToSequence: 90,
  nextAckableSequence: 89,
  reconciliationAction: 'predecessor_replayed',
};

describe('HarnessDriverClient delivery mode diagnostics', () => {
  it('preserves gap reconciliation details when switching to automatic delivery', async () => {
    const client = stubClient({
      mode: 'auto_inject',
      flushed: 0,
      dead_lettered: 0,
      matched: true,
      revision: '7',
      ...gapDiagnostics,
    });

    await expect(client.setInboundDeliveryMode('worker', 'auto_inject')).resolves.toEqual({
      mode: 'auto_inject',
      flushed: 0,
      deadLettered: 0,
      matched: true,
      revision: '7',
      ...parsedGapDiagnostics,
    });
  });

  it('preserves gap reconciliation details from an explicit flush', async () => {
    const client = stubClient({
      flushed: 0,
      dead_lettered: 0,
      held: 13,
      ...gapDiagnostics,
    });

    await expect(client.flushPending('worker')).resolves.toEqual({
      flushed: 0,
      deadLettered: 0,
      held: 13,
      ...parsedGapDiagnostics,
    });
  });
});
