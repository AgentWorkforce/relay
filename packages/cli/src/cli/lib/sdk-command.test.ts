import { describe, expect, it, vi } from 'vitest';

const { createCloudWorkspaceMock, relaySdkCreateWorkspaceMock } = vi.hoisted(() => ({
  createCloudWorkspaceMock: vi.fn(),
  relaySdkCreateWorkspaceMock: vi.fn(),
}));

vi.mock('@agent-relay/cloud', () => ({
  createWorkspace: createCloudWorkspaceMock,
}));

vi.mock('@agent-relay/sdk', () => ({
  AgentRelay: { createWorkspace: relaySdkCreateWorkspaceMock },
}));

vi.mock('./sdk-client.js', () => ({
  createAgentRelay: vi.fn(),
  createWorkspaceRelay: vi.fn(),
}));

import { withSdkDefaults } from './sdk-command.js';

// Regression coverage for AgentWorkforce/relay#1260: `workspace create` must go
// through Cloud's unified `/api/v1/workspaces` endpoint (which persists the
// Postgres row `workspace active` looks up), never the direct-Relaycast
// `AgentRelay.createWorkspace` path — a key minted that way is a permanent
// orphan that 404s on every future `workspace active` / `agentworkforce login`.
describe('withSdkDefaults createWorkspace', () => {
  it('creates a workspace through @agent-relay/cloud, not the direct-Relaycast SDK', async () => {
    createCloudWorkspaceMock.mockResolvedValueOnce({
      workspaceId: 'rw_new',
      relaycastApiKey: 'rk_live_new',
    });

    const deps = withSdkDefaults();
    const result = await deps.createWorkspace('new-ws', 'https://cloud.test');

    expect(createCloudWorkspaceMock).toHaveBeenCalledWith('new-ws', { apiUrl: 'https://cloud.test' });
    expect(relaySdkCreateWorkspaceMock).not.toHaveBeenCalled();
    expect(result).toEqual({ workspaceId: 'rw_new', relaycastApiKey: 'rk_live_new' });
  });
});
