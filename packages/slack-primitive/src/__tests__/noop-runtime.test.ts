import { describe, expect, it, vi } from 'vitest';

import { SlackNoopClient } from '../noop-runtime.js';

describe('SlackNoopClient', () => {
  it('returns a noop ts and logs a warning', async () => {
    const logger = vi.fn();
    const client = new SlackNoopClient({ env: {} }, logger);

    const result = await client.postMessage({
      channel: '#general',
      text: 'PR opened',
      mentions: ['@khaliq'],
    });

    expect(result).toMatchObject({
      channel: '#general',
      ts: '0000000000.000000',
      text: 'PR opened',
      resolvedMentions: [],
      unresolvedMentions: ['@khaliq'],
    });
    expect(result.warnings).toHaveLength(1);
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it('reports noop runtime and unauthenticated', async () => {
    const client = new SlackNoopClient({ env: {} }, vi.fn());
    expect(client.getRuntime()).toBe('noop');
    await expect(client.isAuthenticated()).resolves.toBe(false);
  });

  it('throws auth_token_missing on resolveUser/resolveChannel', async () => {
    const client = new SlackNoopClient({ env: {} }, vi.fn());
    await expect(client.resolveUser({ mention: '@khaliq' })).rejects.toMatchObject({
      code: 'auth_token_missing',
    });
    await expect(client.resolveChannel({ channel: '#general' })).rejects.toMatchObject({
      code: 'auth_token_missing',
    });
  });
});
