import { describe, expect, it } from 'vitest';

import { buildBrokerSpawnConfig } from './client.js';

describe('buildBrokerSpawnConfig', () => {
  it('does not promote legacy RELAY_API_KEY into explicit workspace-key argv', () => {
    const config = buildBrokerSpawnConfig(
      {
        cwd: '/tmp/my-project',
        env: {
          RELAY_API_KEY: 'rk_live_legacy',
        },
      },
      'br_test',
      {}
    );

    expect(config.workspaceKey).toBeUndefined();
    expect(config.args).not.toContain('--workspace-key');
    expect(config.env.RELAY_API_KEY).toBe('rk_live_legacy');
  });

  it('promotes canonical workspace-key env vars into explicit workspace-key argv', () => {
    const config = buildBrokerSpawnConfig(
      {
        cwd: '/tmp/my-project',
        env: {
          AGENT_RELAY_WORKSPACE_KEY: 'rk_live_workspace',
          RELAY_API_KEY: 'rk_live_legacy',
        },
      },
      'br_test',
      {}
    );

    expect(config.workspaceKey).toBe('rk_live_workspace');
    expect(config.args).toContain('--workspace-key');
    expect(config.args).toContain('rk_live_workspace');
    expect(config.env.AGENT_RELAY_WORKSPACE_KEY).toBe('rk_live_workspace');
    expect(config.env.RELAY_WORKSPACE_KEY).toBe('rk_live_workspace');
    expect(config.env.RELAY_API_KEY).toBe('rk_live_workspace');
  });
});
