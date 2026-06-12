import { describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  ensureAuthenticated: vi.fn(),
  authorizedApiFetch: vi.fn(),
}));

vi.mock('./auth.js', () => ({
  ensureAuthenticated: (...args: unknown[]) => authMocks.ensureAuthenticated(...args),
  authorizedApiFetch: (...args: unknown[]) => authMocks.authorizedApiFetch(...args),
}));

import { listAccountUsage } from './usage.js';

describe('listAccountUsage', () => {
  it('loads cloud agents with usage snapshots', async () => {
    const auth = { apiUrl: 'https://cloud.test' };
    authMocks.ensureAuthenticated.mockResolvedValueOnce(auth);
    authMocks.authorizedApiFetch.mockResolvedValueOnce({
      response: new Response(JSON.stringify({
        agents: [
          {
            id: 'agent-1',
            displayName: 'Codex',
            usage: {
              provider: 'openai',
              status: 'available',
              source: 'codex-oauth',
              fetchedAt: '2026-06-12T10:00:00.000Z',
              windows: [],
            },
          },
        ],
      })),
    });

    const agents = await listAccountUsage({ apiUrl: 'https://cloud.test' });

    expect(agents[0].id).toBe('agent-1');
    expect(authMocks.ensureAuthenticated).toHaveBeenCalledWith('https://cloud.test');
    expect(authMocks.authorizedApiFetch).toHaveBeenCalledWith(auth, '/api/v1/cloud-agents?usage=1', {
      method: 'GET',
    });
  });

  it('throws cloud errors', async () => {
    authMocks.ensureAuthenticated.mockResolvedValueOnce({ apiUrl: 'https://cloud.test' });
    authMocks.authorizedApiFetch.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'nope' }), { status: 500 }),
    });

    await expect(listAccountUsage({ apiUrl: 'https://cloud.test' })).rejects.toThrow('nope');
  });
});
