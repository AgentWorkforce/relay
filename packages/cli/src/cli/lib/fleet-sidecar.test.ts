import { describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  AgentRelay: vi.fn(),
  triggers: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
  },
}));

vi.mock('@agent-relay/sdk', () => ({
  AgentRelay: vi.fn(function (this: unknown, options: unknown) {
    sdkMocks.AgentRelay(options);
    return { triggers: sdkMocks.triggers };
  }),
}));

import type { CoreProjectPaths } from '../commands/core.js';
import { createImplicitLocalFleetNode, createTriggerSyncClient, fleetStatusPath } from './fleet-sidecar.js';

const paths: CoreProjectPaths = {
  projectRoot: '/tmp/my-project',
  dataDir: '/tmp/my-project/.agentworkforce/relay',
  teamDir: '/tmp/my-project/.agentworkforce/relay/teams',
};

describe('fleetStatusPath', () => {
  it('resolves the diagnostic status file inside the data dir', () => {
    expect(fleetStatusPath(paths)).toBe('/tmp/my-project/.agentworkforce/relay/fleet-node.json');
  });
});

describe('createImplicitLocalFleetNode', () => {
  it('derives the node name from the project root basename by default', () => {
    const node = createImplicitLocalFleetNode({ paths, teamsConfig: null });

    expect(node.name).toBe('my-project');
    expect(Object.keys(node.capabilities)).toEqual(
      expect.arrayContaining(['spawn:claude', 'spawn:codex', 'spawn:gemini'])
    );
  });

  it('honors an explicit name override', () => {
    const node = createImplicitLocalFleetNode({ paths, teamsConfig: null, name: 'custom-node' });

    expect(node.name).toBe('custom-node');
  });
});

describe('createTriggerSyncClient', () => {
  it('constructs an AgentRelay with the workspace key and base URL', () => {
    createTriggerSyncClient({ workspaceKey: 'rk_live_test', baseUrl: 'https://relay.example' });

    expect(sdkMocks.AgentRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      baseUrl: 'https://relay.example',
    });
  });

  it('omits baseUrl when not provided', () => {
    sdkMocks.AgentRelay.mockClear();
    createTriggerSyncClient({ workspaceKey: 'rk_live_test' });

    expect(sdkMocks.AgentRelay).toHaveBeenCalledWith({ workspaceKey: 'rk_live_test' });
  });

  it('maps list/create/update/delete onto the relay triggers API', async () => {
    const client = createTriggerSyncClient({ workspaceKey: 'rk_live_test' });

    await client.list();
    await client.create({ actionName: 'echo', enabled: true });
    await client.update('trigger-1', { actionName: 'echo', enabled: false });
    await client.delete('trigger-1');

    expect(sdkMocks.triggers.list).toHaveBeenCalledTimes(1);
    expect(sdkMocks.triggers.create).toHaveBeenCalledWith({ actionName: 'echo', enabled: true });
    expect(sdkMocks.triggers.update).toHaveBeenCalledWith('trigger-1', {
      actionName: 'echo',
      enabled: false,
    });
    expect(sdkMocks.triggers.delete).toHaveBeenCalledWith('trigger-1');
  });
});
