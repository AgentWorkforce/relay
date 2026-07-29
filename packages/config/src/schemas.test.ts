import { describe, it, expect } from 'vitest';
import {
  ConnectionConfigSchema,
  TmuxWrapperConfigSchema,
  CloudConfigSchema,
  BridgeConfigSchema,
  RelayRuntimeConfigSchema,
  ShadowConfigSchema,
  jsonSchemas,
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

  it('validates cloud config with daytona provider', () => {
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
      compute: { provider: 'daytona' },
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

  it('rejects invalid compute provider', () => {
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
      compute: { provider: 'invalid_provider' },
      nango: { secretKey: 'nango-secret' },
      stripe: {
        secretKey: 'sk',
        publishableKey: 'pk',
        webhookSecret: 'whsec',
        priceIds: {},
      },
      adminUsers: [],
    };
    expect(() => CloudConfigSchema.parse(cfg)).toThrow();
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

  it('validates shadow config with keyed pair and role records', () => {
    const cfg = {
      shadows: {
        pairs: { Builder: { shadow: 'Reviewer', speakOn: ['commit'] } },
        roles: { Reviewer: { prompt: 'review carefully', speakOn: [] } },
      },
    };
    expect(ShadowConfigSchema.parse(cfg)).toEqual(cfg);
  });
});

describe('jsonSchemas', () => {
  const entries = Object.entries(jsonSchemas) as Array<[string, Record<string, unknown>]>;

  it('exposes one schema per config surface', () => {
    expect(entries.map(([name]) => name)).toEqual([
      'connection',
      'tmuxWrapper',
      'relayRuntime',
      'bridge',
      'teams',
      'shadow',
      'agentFrontmatter',
      'cliAuth',
      'cloud',
    ]);
  });

  it.each(entries)('renders %s as an identified draft-7 object schema', (_name, schema) => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(typeof schema.$id).toBe('string');
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeTypeOf('object');
  });

  it('describes config files as written, leaving defaulted fields optional', () => {
    // `agents` has `.default([])`, so a hand-written teams config may omit it.
    const teams = jsonSchemas.teams as {
      required: string[];
      properties: { agents: { default: unknown } };
    };
    expect(teams.required).toEqual(['team']);
    expect(teams.properties.agents.default).toEqual([]);
  });

  it('renders RegExp fields as unconstrained rather than failing to serialize', () => {
    // `z.instanceof(RegExp)` has no JSON Schema equivalent; it must degrade to
    // "anything" instead of throwing while the rest of the schema still renders.
    const cliAuth = jsonSchemas.cliAuth as {
      properties: { urlPattern: Record<string, unknown>; command: { type: string } };
    };
    expect(cliAuth.properties.urlPattern).toEqual({});
    expect(cliAuth.properties.command.type).toBe('string');
  });
});
