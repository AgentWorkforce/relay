import { describe, expect, it, vi } from 'vitest';

import { resolveFleetNodeId } from './resolve-fleet-node-id.js';

const options = { workspaceKey: 'rk_live_test', baseUrl: 'https://agent37-cast.agentrelay.com' };

function roster(nodes: Array<{ id?: string; nodeId?: string; name: string }>) {
  const list = vi.fn(async () => nodes);
  const create = vi.fn(
    (_options: { workspaceKey: string; baseUrl: string }) => ({ nodes: { list } }) as never
  );
  return { list, create };
}

describe('resolveFleetNodeId', () => {
  it('uses the selected credential and route to resolve a name to its stable ID', async () => {
    const { list, create } = roster([{ id: 'node_123', name: 'sf-mini' }]);
    await expect(resolveFleetNodeId(' #sf-mini ', options, create)).resolves.toBe('node_123');
    expect(create).toHaveBeenCalledWith(options);
    expect(list).toHaveBeenCalledOnce();
  });

  it('preserves a raw ID even when a different node uses it as a name', async () => {
    const { create, list } = roster([{ id: 'node_456', name: 'node_123' }]);
    await expect(resolveFleetNodeId('node_123', options, create)).resolves.toBe('node_123');
    expect(list).not.toHaveBeenCalled();
  });

  it('preserves a roster ID without a standard prefix', async () => {
    const { create } = roster([{ nodeId: 'sandbox-1-id', name: 'sandbox-1' }]);
    await expect(resolveFleetNodeId('sandbox-1-id', options, create)).resolves.toBe('sandbox-1-id');
  });

  it('preserves a stable ID absent from the roster', async () => {
    const { create } = roster([]);
    await expect(resolveFleetNodeId('node_123', options, create)).resolves.toBe('node_123');
  });

  it('rejects unknown and ambiguous names before a session can be posted', async () => {
    const { create } = roster([
      { id: 'node_1', name: 'sf-mini' },
      { id: 'node_2', name: 'sf-mini' },
    ]);
    await expect(resolveFleetNodeId('unknown', options, create)).rejects.toMatchObject({
      code: 'node_not_found',
    });
    await expect(resolveFleetNodeId('sf-mini', options, create)).rejects.toMatchObject({
      code: 'ambiguous_node',
    });
  });
});
