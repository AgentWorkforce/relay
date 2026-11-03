import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSubscriptionAgentChannel } from './integration-recipient.js';

describe('subscription recipient channel', () => {
  const input = { options: { workspaceKey: 'rk_live_explicit' } };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('returns the verified single-member subscription channel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: { name: 'agent-events-id', members: [{ agent_name: 'fresh' }] } }),
            { status: 200 }
          )
      )
    );
    await expect(resolveSubscriptionAgentChannel('fresh', input.options)).resolves.toBe('agent-events-id');
  });
  it('rejects unexpected members and never substitutes a same-named channel', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { name: 'agent-events-id', members: [{ agent_name: 'fresh' }, { agent_name: 'other' }] },
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(resolveSubscriptionAgentChannel('fresh', input.options)).rejects.toThrow(
      'membership did not verify'
    );
    expect(fetcher.mock.calls[0][0].toString()).toBe(
      'https://cast.agentrelay.com/v1/agents/fresh/subscription-channel'
    );
  });
});
