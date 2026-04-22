import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition, SwarmConfig } from '../types.js';
import {
  buildNormalizedProxyEnv,
  createProxyEnvResolver,
  getStrippedApiKeyVars,
  isProxyEnabled,
  RELAY_PROXY_TOKEN_ENV,
  RELAY_PROXY_TOKEN_ENV_ALIAS,
  RELAY_PROXY_URL_ENV,
  RELAY_PROXY_URL_ENV_ALIAS,
  resolveProxyTokenFromEnv,
  resolveProxyUrlFromEnv,
  resolveProxyEnv,
  type ProxyEnvRegistry,
} from '../proxy-env.js';
import { WorkflowRunner } from '../runner.js';

describe('proxy-env', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['claude', { ANTHROPIC_BASE_URL: 'https://proxy.local', ANTHROPIC_API_KEY: 'proxy-token' }],
    ['codex', { OPENAI_BASE_URL: 'https://proxy.local', OPENAI_API_KEY: 'proxy-token' }],
    ['opencode', { OPENAI_BASE_URL: 'https://proxy.local', OPENAI_API_KEY: 'proxy-token' }],
    ['aider', { OPENAI_API_BASE: 'https://proxy.local', OPENAI_API_KEY: 'proxy-token' }],
    ['gemini', { GOOGLE_API_BASE: 'https://proxy.local', GOOGLE_API_KEY: 'proxy-token' }],
    ['goose', { OPENAI_BASE_URL: 'https://proxy.local', OPENAI_API_KEY: 'proxy-token' }],
    ['droid', { OPENAI_BASE_URL: 'https://proxy.local', OPENAI_API_KEY: 'proxy-token' }],
    ['cursor', { OPENAI_BASE_URL: 'https://proxy.local', OPENAI_API_KEY: 'proxy-token' }],
  ] as const)('returns the correct env overrides for %s', (cli, expected) => {
    expect(resolveProxyEnv(cli, 'https://proxy.local', 'proxy-token')).toEqual(expected);
  });

  it('normalizes cli variants before resolving proxy env', () => {
    expect(resolveProxyEnv('codex:gpt-5.4', 'https://proxy.local', 'proxy-token')).toEqual({
      OPENAI_BASE_URL: 'https://proxy.local',
      OPENAI_API_KEY: 'proxy-token',
    });
    expect(resolveProxyEnv('cursor-agent', 'https://proxy.local', 'proxy-token')).toEqual({
      OPENAI_BASE_URL: 'https://proxy.local',
      OPENAI_API_KEY: 'proxy-token',
    });
  });

  it('falls back to dual-provider overrides for unknown CLIs and logs a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveProxyEnv('mystery-cli', 'https://proxy.local', 'proxy-token')).toEqual({
      OPENAI_BASE_URL: 'https://proxy.local',
      OPENAI_API_KEY: 'proxy-token',
      ANTHROPIC_BASE_URL: 'https://proxy.local',
      ANTHROPIC_API_KEY: 'proxy-token',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Falling back to generic OpenAI/Anthropic proxy env overrides.')
    );
  });

  it('returns the full provider/base-url strip list', () => {
    expect(getStrippedApiKeyVars()).toEqual([
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'GOOGLE_API_KEY',
      'OPENAI_BASE_URL',
      'ANTHROPIC_BASE_URL',
      'OPENAI_API_BASE',
      'GOOGLE_API_BASE',
    ]);
  });

  it('does not strip canonical or legacy relay proxy env vars', () => {
    expect(getStrippedApiKeyVars()).not.toContain(RELAY_PROXY_URL_ENV);
    expect(getStrippedApiKeyVars()).not.toContain(RELAY_PROXY_URL_ENV_ALIAS);
    expect(getStrippedApiKeyVars()).not.toContain(RELAY_PROXY_TOKEN_ENV);
    expect(getStrippedApiKeyVars()).not.toContain(RELAY_PROXY_TOKEN_ENV_ALIAS);
  });

  it('prefers the canonical relay proxy URL env name', () => {
    expect(
      resolveProxyUrlFromEnv({
        [RELAY_PROXY_URL_ENV]: 'https://cloud.proxy',
        [RELAY_PROXY_URL_ENV_ALIAS]: 'https://legacy.proxy',
      })
    ).toBe('https://cloud.proxy');
  });

  it('falls back to the legacy relay proxy URL env name', () => {
    expect(
      resolveProxyUrlFromEnv({
        [RELAY_PROXY_URL_ENV_ALIAS]: 'https://legacy.proxy',
      })
    ).toBe('https://legacy.proxy');
  });

  it('prefers the canonical relay proxy token env name', () => {
    expect(
      resolveProxyTokenFromEnv({
        [RELAY_PROXY_TOKEN_ENV]: 'cloud-token',
        [RELAY_PROXY_TOKEN_ENV_ALIAS]: 'legacy-token',
      })
    ).toBe('cloud-token');
  });

  it('falls back to the legacy relay proxy token env name', () => {
    expect(
      resolveProxyTokenFromEnv({
        [RELAY_PROXY_TOKEN_ENV_ALIAS]: 'legacy-token',
      })
    ).toBe('legacy-token');
  });

  it('emits canonical and legacy relay proxy env vars together', () => {
    expect(buildNormalizedProxyEnv('https://proxy.local', 'proxy-token')).toEqual({
      RELAY_LLM_PROXY: 'https://proxy.local',
      RELAY_LLM_PROXY_URL: 'https://proxy.local',
      CREDENTIAL_PROXY_TOKEN: 'proxy-token',
      RELAY_LLM_PROXY_TOKEN: 'proxy-token',
    });
  });

  it('enables proxy mode only when both agent and swarm opt in', () => {
    const agentWithProxy = { credentials: { proxy: true } } as AgentDefinition;
    const agentWithoutProxy = { credentials: { proxy: false } } as AgentDefinition;
    const swarmWithProxy = {
      credentialProxy: {
        proxyUrl: 'https://proxy.local',
        providers: {},
      },
    } as SwarmConfig;
    const swarmWithoutProxy = {} as SwarmConfig;

    expect(isProxyEnabled(agentWithProxy, swarmWithProxy)).toBe(true);
    expect(isProxyEnabled(agentWithoutProxy, swarmWithProxy)).toBe(false);
    expect(isProxyEnabled(agentWithProxy, swarmWithoutProxy)).toBe(false);
    expect(isProxyEnabled(undefined, swarmWithProxy)).toBe(false);
    expect(isProxyEnabled(agentWithProxy, undefined)).toBe(false);
  });

  it('supports adding a new CLI by supplying one registry entry', () => {
    const customRegistry = {
      'custom-cli': [{ baseUrlVar: 'CUSTOM_API_BASE', apiKeyVar: 'CUSTOM_API_KEY' }],
    } satisfies ProxyEnvRegistry;
    const resolveCustomProxyEnv = createProxyEnvResolver(customRegistry);

    expect(resolveCustomProxyEnv('custom-cli', 'https://proxy.local', 'proxy-token')).toEqual({
      CUSTOM_API_BASE: 'https://proxy.local',
      CUSTOM_API_KEY: 'proxy-token',
    });
  });

  it('normalizes inherited proxy env before child-process propagation', () => {
    const runner = new WorkflowRunner({
      relay: {
        env: {
          RELAY_LLM_PROXY_URL: 'https://legacy.proxy',
          RELAY_LLM_PROXY_TOKEN: 'legacy-token',
          OPENAI_API_KEY: 'should-strip',
        },
      },
    });

    const env = (runner as any).getRelayEnv();

    expect(env).toMatchObject({
      RELAY_LLM_PROXY: 'https://legacy.proxy',
      RELAY_LLM_PROXY_URL: 'https://legacy.proxy',
      CREDENTIAL_PROXY_TOKEN: 'legacy-token',
      RELAY_LLM_PROXY_TOKEN: 'legacy-token',
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
