import { describe, it, expect } from 'vitest';
import type { Envelope, ErrorPayload } from '../protocol/types.js';
import { RelayClient } from './client.js';

describe('RelayClient', () => {
  it('clears resume token after RESUME_TOO_OLD error', () => {
    const client = new RelayClient({ reconnect: false });

    // Simulate a stored resume token that the server rejects
    (client as any).resumeToken = 'stale-token';

    const errorEnvelope: Envelope<ErrorPayload> = {
      v: 1,
      type: 'ERROR',
      id: 'err-1',
      ts: Date.now(),
      payload: {
        code: 'RESUME_TOO_OLD',
        message: 'Session resume not yet supported; starting new session',
        fatal: false,
      },
    };

    (client as any).processFrame(errorEnvelope);

    expect((client as any).resumeToken).toBeUndefined();
  });
});
