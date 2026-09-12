import { describe, expect, it } from 'vitest';

import { resolveFleetAttachTarget } from './fleet-attach-target.js';

const node = (name: string, agents: string[]) => ({
  name,
  nodeId: `${name}-id`,
  status: 'online' as const,
  live: true,
  handlersLive: true,
  capabilities: [{ name: 'relay:live-agents:v1', metadata: { names: agents } }],
});

describe('resolveFleetAttachTarget', () => {
  it('returns the unique live node and persisted route', async () => {
    await expect(
      resolveFleetAttachTarget(
        'sandbox-worker',
        () => ({ nodes: { list: async () => [node('sandbox-1', ['sandbox-worker'])] } }) as never,
        () => ({ baseUrl: 'https://agent37-cast.agentrelay.com' })
      )
    ).resolves.toEqual({
      target: { node: 'sandbox-1', baseUrl: 'https://agent37-cast.agentrelay.com' },
    });
  });

  it('reports ambiguity instead of guessing a node', async () => {
    await expect(
      resolveFleetAttachTarget(
        'worker',
        () => ({ nodes: { list: async () => [node('one', ['worker']), node('two', ['worker'])] } }) as never,
        () => ({})
      )
    ).resolves.toMatchObject({ error: expect.stringContaining('multiple fleet nodes') });
  });

  it('redacts transport error details before returning persisted-session diagnostics', async () => {
    const result = await resolveFleetAttachTarget(
      'worker',
      (() => {
        throw new Error('request failed for https://relay.example/?api_key=rk_live_fake_secret');
      }) as never,
      () => ({}),
      () => ({
        key: 'rk_live_workspace',
        source: 'project',
        origin: '/tmp/project/.agentworkforce/relay/workspace-key.json',
        relaycastRoute: 'agent37-isolated',
        relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      })
    );

    expect(result.error).toContain('persisted remote Fleet session');
    expect(result.error).not.toContain('rk_live_fake_secret');
  });

  it('does not leak parse errors while reading the project session', async () => {
    const result = await resolveFleetAttachTarget(
      'worker',
      (() => ({ nodes: { list: async () => [] } })) as never,
      () => ({}),
      (() => {
        throw new Error('invalid session token=rk_live_parse_secret');
      }) as never
    );

    expect(result.error).toContain('could not read the persisted workspace session');
    expect(result.error).not.toContain('rk_live_parse_secret');
  });
});
