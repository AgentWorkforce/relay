import { afterEach, describe, expect, it, vi } from 'vitest';

const connectMock = vi.hoisted(() => vi.fn());

vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: {
    connect: connectMock,
  },
}));

describe('project broker client resolution', () => {
  afterEach(() => {
    connectMock.mockReset();
    vi.unstubAllEnvs();
  });

  it('connects through the project connection file even when AGENT_RELAY_STATE_DIR points elsewhere', async () => {
    const client = { getSession: vi.fn(async () => ({ workspace_key: 'rk_live_project' })) };
    connectMock.mockReturnValue(client);
    vi.stubEnv('AGENT_RELAY_STATE_DIR', '/tmp/stale-state');

    const { connectProjectBrokerClient, getProjectBrokerConnectionPath } =
      await import('./project-broker-client.js');

    expect(getProjectBrokerConnectionPath('/tmp/project')).toBe('/tmp/project/.agent-relay/connection.json');
    expect(connectProjectBrokerClient('/tmp/project')).toBe(client);
    expect(connectMock).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      connectionPath: '/tmp/project/.agent-relay/connection.json',
    });
  });
});
