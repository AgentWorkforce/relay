import { describe, it, expect } from 'vitest';
import {
  ConnectionConfigSchema,
  TmuxWrapperConfigSchema,
  CloudConfigSchema,
  BridgeConfigSchema,
  RelayRuntimeConfigSchema,
} from './schemas.js';
import { DEFAULT_CONNECTION_CONFIG, DEFAULT_TMUX_WRAPPER_CONFIG } from './relay-config.js';

describe('config schemas', () => {
  it('validates connection defaults', () => {
    expect(ConnectionConfigSchema.parse(DEFAULT_CONNECTION_CONFIG)).toEqual(DEFAULT_CONNECTION_CONFIG);
  });

  it('validates tmux wrapper defaults', () => {
    expect(TmuxWrapperConfigSchema.parse(DEFAULT_TMUX_WRAPPER_CONFIG)).toEqual(DEFAULT_TMUX_WRAPPER_CONFIG);
  });

  it('validates minimal cloud config', () => {
    const cfg = {
      port: 4567,
      publicUrl: 'http://localhost:4567',
      appUrl: 'http://localhost:3000',
      sessionSecret: 'secret',
      databaseUrl: 'postgres://user:pass@localhost:5432/db',
      redisUrl: 'redis://localhost:6379',
      github: { clientId: 'id', clientSecret: 'secret' },
      providers: {},
      vault: { masterKey: '0123456789abcdef0123456789abcdef' },
      compute: { provider: 'docker' },
      nango: { secretKey: 'nango-secret' },
      stripe: {
        secretKey: 'sk',
        publishableKey: 'pk',
        webhookSecret: 'whsec',
        priceIds: {},
      },
      adminUsers: [],
    };
    expect(CloudConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it('validates bridge config shape', () => {
    const cfg = {
      projects: {
        '/repo/path': { lead: 'Lead', cli: 'claude' },
      },
      defaultCli: 'claude',
    };
    expect(BridgeConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it('validates relay runtime config', () => {
    expect(RelayRuntimeConfigSchema.parse({ trajectories: { storeInRepo: true } })).toEqual({
      trajectories: { storeInRepo: true },
    });
  });
});
