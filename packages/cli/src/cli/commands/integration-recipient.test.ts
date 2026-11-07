import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSubscriptionAgentChannel } from './integration-recipient.js';

describe('subscription recipient channel', () => {
  const input = { options: { workspaceKey: 'rk_live_explicit' } };
  beforeEach(() => {
    // The asserted URLs are the hosted default; an ambient override must not leak in.
    vi.stubEnv('RELAY_BASE_URL', '');
    vi.stubEnv('RELAYCAST_BASE_URL', '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it.each([401, 409, 429, 503])(
    'reports HTTP %i with its error code and no upgrade remedy',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error: { code: 'some_code' } }), { status }))
      );
      const error = await resolveSubscriptionAgentChannel('fresh', input.options).catch((err: Error) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status} some_code`);
      expect((error as Error).message).not.toContain('Upgrade');
      expect((error as Error).message).toContain('No subscription resources were created');
    }
  );
  it.each([404, 405])('names the Relaycast upgrade for HTTP %i', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status }))
    );
    await expect(resolveSubscriptionAgentChannel('fresh', input.options)).rejects.toThrow(
      'relaycast PR #387'
    );
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
