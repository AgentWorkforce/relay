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
  return {
    client: new HarnessDriverClient({ baseUrl: 'http://broker', apiKey: 'secret', fetch }),
    fetch,
  };
}

describe('HarnessDriverClient.sendMessage', () => {
  it('preserves the broker reachability observation without promoting publication to delivery', async () => {
    const { client, fetch } = stubClient({
      success: true,
      event_id: 'http_1',
      relaycast_published: true,
      delivery_status: 'published_unconfirmed',
      recipient_live: false,
      recipient_status: 'offline',
      local: false,
      workspace_id: 'ws_1',
      workspace_alias: null,
    });

    const result = await client.sendMessage({ to: 'queued-worker', text: 'hello' });

    expect(result).toMatchObject({
      targets: [],
      relaycast_published: true,
      delivery_status: 'published_unconfirmed',
      recipient_live: false,
      recipient_status: 'offline',
    });
    expect(result).not.toHaveProperty('delivered');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps the legacy unsupported-operation result representable', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'unsupported_operation', error: 'not supported' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof globalThis.fetch;
    const client = new HarnessDriverClient({ baseUrl: 'http://broker', fetch });

    await expect(client.sendMessage({ to: '#general', text: 'hello' })).resolves.toEqual({
      event_id: 'unsupported_operation',
      targets: [],
    });
  });
});
