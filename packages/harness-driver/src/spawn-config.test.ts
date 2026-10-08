import { describe, expect, it } from 'vitest';

import { buildBrokerSpawnConfig } from './spawn-config.js';

describe('buildBrokerSpawnConfig', () => {
  for (const name of [
    'RELAY_NODE_ID',
    'RELAY_NODE_TOKEN',
    'AGENT_RELAY_ENROLLED_NODE_ID',
    'RELAY_WORKSPACE_KEY',
    'AGENT_RELAY_WORKSPACE_KEY',
    'RELAY_API_KEY',
  ]) {
    it(`refuses caller-owned ${name} in an isolated explicit environment`, () => {
      expect(() =>
        buildBrokerSpawnConfig(
          {
            inheritParentEnv: false,
            env: { [name]: 'poisoned' },
          },
          'br_test',
          {}
        )
      ).toThrow(name);
    });
  }

  it('can isolate a child from a poisoned parent environment', () => {
    const config = buildBrokerSpawnConfig(
      {
        cwd: '/tmp/my-project',
        inheritParentEnv: false,
        env: {
          PATH: '/safe/bin',
        },
      },
      'br_test',
      {
        RELAY_NODE_ID: 'poisoned-node',
        RELAY_NODE_TOKEN: 'poisoned-token',
        AGENT_RELAY_ENROLLED_NODE_ID: 'poisoned-enrollment',
        RELAY_WORKSPACE_KEY: 'poisoned-workspace',
        UNRELATED_PARENT_SECRET: 'poisoned-secret',
      }
    );

    expect(config.env).toEqual({
      PATH: '/safe/bin',
      AGENT_RELAY_STARTUP_DEBUG: '1',
      RELAY_BROKER_API_KEY: 'br_test',
      AGENT_RELAY_BROKER_NAME: 'my-project',
    });
  });

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

  it('carries the canonical workspace key in env only, never on argv', () => {
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
    expect(config.args).not.toContain('--workspace-key');
    expect(config.args).not.toContain('rk_live_workspace');
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
    expect(config.env.AGENT_RELAY_WORKSPACE_KEY).toBe('rk_live_env_workspace');
    expect(config.args).toEqual([
      'init',
      '--instance-name',
      'parent-broker',
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

  it('prefers RELAY_WORKSPACE_KEY over AGENT_RELAY_WORKSPACE_KEY in the same env', () => {
    const config = buildBrokerSpawnConfig(
      {
        cwd: '/tmp/my-project',
        env: {
          RELAY_WORKSPACE_KEY: 'rk_live_primary',
          AGENT_RELAY_WORKSPACE_KEY: 'rk_live_alias',
        },
      },
      'br_test',
      {}
    );

    expect(config.workspaceKey).toBe('rk_live_primary');
    expect(config.env.RELAY_WORKSPACE_KEY).toBe('rk_live_primary');
    expect(config.env.AGENT_RELAY_WORKSPACE_KEY).toBe('rk_live_primary');
  });
});
