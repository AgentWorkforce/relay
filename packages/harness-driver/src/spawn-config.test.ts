import { describe, expect, it } from 'vitest';

import { buildBrokerSpawnConfig } from './spawn-config.js';

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

  it('uses the canonical workspace-key precedence chain before broker init args', () => {
    const config = buildBrokerSpawnConfig(
      {
        cwd: '/tmp/my-project',
        brokerName: '  ',
        env: {
          AGENT_RELAY_WORKSPACE_KEY: '  ',
          RELAY_WORKSPACE_KEY: 'rk_live_env_workspace',
        },
        binaryArgs: {
          persist: true,
          apiPort: 0,
          apiBind: '127.0.0.1',
          stateDir: '/tmp/relay-state',
        },
      },
      'br_test',
      {
        AGENT_RELAY_BROKER_NAME: 'parent-broker',
        AGENT_RELAY_WORKSPACE_KEY: 'rk_live_parent_workspace',
      }
    );

    expect(config.brokerName).toBe('parent-broker');
    expect(config.workspaceKey).toBe('rk_live_env_workspace');
    expect(config.args).toEqual([
      'init',
      '--instance-name',
      'parent-broker',
      '--workspace-key',
      'rk_live_env_workspace',
      '--channels',
      'general',
      '--persist',
      '--api-port',
      '0',
      '--api-bind',
      '127.0.0.1',
      '--state-dir',
      '/tmp/relay-state',
    ]);
  });

  it('does not reintroduce host-only variables when an isolated parent env is supplied', () => {
    const hostOnlyKey = 'AGENT_RELAY_TEST_HOST_ONLY';
    const originalHostOnly = process.env[hostOnlyKey];
    process.env[hostOnlyKey] = 'host-secret';
    const parentEnv = { EMBEDDED_ONLY: '1' } as NodeJS.ProcessEnv;

    try {
      const config = buildBrokerSpawnConfig(
        {
          cwd: '/tmp/my-project',
          env: parentEnv,
          parentEnv,
        },
        'br_test'
      );

      expect(config.env.EMBEDDED_ONLY).toBe('1');
      expect(config.env[hostOnlyKey]).toBeUndefined();
    } finally {
      if (originalHostOnly === undefined) delete process.env[hostOnlyKey];
      else process.env[hostOnlyKey] = originalHostOnly;
    }
  });
});
