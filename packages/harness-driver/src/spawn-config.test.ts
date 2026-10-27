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
  describe('run-token mode', () => {
    const RUN_FILE = '/home/agent/.relay/run-access/relaycast-run.json';
    const KEY_VARS = [
      'RELAY_API_KEY',
      'RELAY_WORKSPACE_KEY',
      'AGENT_RELAY_WORKSPACE_KEY',
      'RELAY_WORKSPACES_JSON',
    ];

    function expectNoWorkspaceCredentials(config: ReturnType<typeof buildBrokerSpawnConfig>) {
      for (const name of KEY_VARS) {
        expect(config.env).not.toHaveProperty(name);
      }
      expect(config.workspaceKey).toBeUndefined();
      const serialized = JSON.stringify({ env: config.env, args: config.args });
      expect(serialized).not.toMatch(/rk_(live|test)_/);
      expect(serialized).not.toMatch(/rt_(live|test)_/);
    }

    it('passes only the run token file path to the broker for an explicit runTokenFile', () => {
      const config = buildBrokerSpawnConfig(
        { cwd: '/tmp/my-project', runTokenFile: RUN_FILE },
        'br_test',
        {}
      );

      expect(config.runTokenFile).toBe(RUN_FILE);
      expect(config.env.RELAY_RUN_TOKEN_FILE).toBe(RUN_FILE);
      expect(config.args).not.toContain(RUN_FILE);
      expectNoWorkspaceCredentials(config);
    });

    it('prefers the run token file over an explicit workspaceKey and strips inherited keys', () => {
      const config = buildBrokerSpawnConfig(
        {
          cwd: '/tmp/my-project',
          runTokenFile: RUN_FILE,
          workspaceKey: 'rk_live_explicit',
          env: { RELAY_WORKSPACE_KEY: 'rk_live_caller', RELAY_WORKSPACES_JSON: '{"k":"rk_live_json"}' },
        },
        'br_test',
        { RELAY_API_KEY: 'rk_live_parent', AGENT_RELAY_WORKSPACE_KEY: 'rk_live_parent2', PATH: '/bin' }
      );

      expect(config.env.RELAY_RUN_TOKEN_FILE).toBe(RUN_FILE);
      expect(config.env.PATH).toBe('/bin');
      expectNoWorkspaceCredentials(config);
    });

    it('picks RELAY_RUN_TOKEN_FILE up from the caller env or the parent env', () => {
      const fromCaller = buildBrokerSpawnConfig(
        { cwd: '/tmp/p', env: { RELAY_RUN_TOKEN_FILE: RUN_FILE, RELAY_API_KEY: 'rk_live_x' } },
        'br_test',
        {}
      );
      expect(fromCaller.env.RELAY_RUN_TOKEN_FILE).toBe(RUN_FILE);
      expectNoWorkspaceCredentials(fromCaller);

      const fromParent = buildBrokerSpawnConfig({ cwd: '/tmp/p' }, 'br_test', {
        RELAY_RUN_TOKEN_FILE: RUN_FILE,
        RELAY_WORKSPACE_KEY: 'rk_live_parent',
      });
      expect(fromParent.env.RELAY_RUN_TOKEN_FILE).toBe(RUN_FILE);
      expectNoWorkspaceCredentials(fromParent);
    });

    it('allows a run token file in an isolated explicit environment', () => {
      const config = buildBrokerSpawnConfig(
        {
          cwd: '/tmp/p',
          inheritParentEnv: false,
          env: { PATH: '/safe/bin', RELAY_RUN_TOKEN_FILE: RUN_FILE },
        },
        'br_test',
        { RELAY_API_KEY: 'rk_live_parent' }
      );
      expect(config.env).toEqual({
        PATH: '/safe/bin',
        RELAY_RUN_TOKEN_FILE: RUN_FILE,
        AGENT_RELAY_STARTUP_DEBUG: '1',
        RELAY_BROKER_API_KEY: 'br_test',
        AGENT_RELAY_BROKER_NAME: 'p',
      });
    });

    it('leaves the legacy workspace-key path unchanged when no run token file is set', () => {
      const config = buildBrokerSpawnConfig({ cwd: '/tmp/p', workspaceKey: 'rk_live_legacy' }, 'br_test', {});
      expect(config.runTokenFile).toBeUndefined();
      expect(config.env).not.toHaveProperty('RELAY_RUN_TOKEN_FILE');
      expect(config.env.RELAY_API_KEY).toBe('rk_live_legacy');
      expect(config.env.RELAY_WORKSPACE_KEY).toBe('rk_live_legacy');
      expect(config.env.AGENT_RELAY_WORKSPACE_KEY).toBe('rk_live_legacy');
    });
  });
});
