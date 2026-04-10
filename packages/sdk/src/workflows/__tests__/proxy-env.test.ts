import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition, SwarmConfig } from '../types.js';
import {
  createProxyEnvResolver,
  getStrippedApiKeyVars,
  isProxyEnabled,
  resolveProxyEnv,
  type ProxyEnvRegistry,
} from '../proxy-env.js';

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
});
