import { describe, expect, it, vi } from 'vitest';

import { HarnessDriverClient } from './client.js';

describe('model receipt correlation', () => {
  it('retains an explicitly empty request id in the GET query', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'worker',
            requested_model: 'openai/gpt-5.4',
            effective_model: null,
            status: 'rejected',
            applied: false,
            request_id: '',
            accepted: true,
            pending: false,
            success: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    ) as unknown as typeof globalThis.fetch;
    const client = new HarnessDriverClient({ baseUrl: 'http://broker', apiKey: 'key', fetch });

    await client.getModel('worker', '');

    expect(fetch).toHaveBeenCalledWith(
      'http://broker/api/spawned/worker/model?request_id=',
      expect.objectContaining({ headers: { 'X-API-Key': 'key' } })
    );
  });
});
