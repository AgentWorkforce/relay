import { getCliDefinition } from '../cli-registry.js';
import type { AgentDefinition, SwarmConfig } from './types.js';

export interface ProxyEnvBinding {
  baseUrlVar: string;
  apiKeyVar: string;
}

export type ProxyEnvRegistry = Record<string, readonly ProxyEnvBinding[]>;

export const RELAY_PROXY_URL_ENV = 'RELAY_LLM_PROXY' as const;
export const RELAY_PROXY_URL_ENV_ALIAS = 'RELAY_LLM_PROXY_URL' as const;
export const RELAY_PROXY_TOKEN_ENV = 'CREDENTIAL_PROXY_TOKEN' as const;
export const RELAY_PROXY_TOKEN_ENV_ALIAS = 'RELAY_LLM_PROXY_TOKEN' as const;

const OPENAI_COMPATIBLE_BINDINGS = [
  { baseUrlVar: 'OPENAI_BASE_URL', apiKeyVar: 'OPENAI_API_KEY' },
] as const satisfies readonly ProxyEnvBinding[];

const ANTHROPIC_BINDINGS = [
  { baseUrlVar: 'ANTHROPIC_BASE_URL', apiKeyVar: 'ANTHROPIC_API_KEY' },
] as const satisfies readonly ProxyEnvBinding[];

const AIDER_BINDINGS = [
  { baseUrlVar: 'OPENAI_API_BASE', apiKeyVar: 'OPENAI_API_KEY' },
] as const satisfies readonly ProxyEnvBinding[];

const GEMINI_BINDINGS = [
  { baseUrlVar: 'GOOGLE_API_BASE', apiKeyVar: 'GOOGLE_API_KEY' },
] as const satisfies readonly ProxyEnvBinding[];

const GENERIC_FALLBACK_BINDINGS = [
  ...OPENAI_COMPATIBLE_BINDINGS,
  ...ANTHROPIC_BINDINGS,
] as const satisfies readonly ProxyEnvBinding[];

const STRIPPED_API_KEY_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_BASE',
  'GOOGLE_API_BASE',
] as const;

const CLI_ALIASES: Record<string, string> = {
  agent: 'cursor',
  'cursor-agent': 'cursor',
};

export const DEFAULT_PROXY_ENV_REGISTRY = {
  claude: ANTHROPIC_BINDINGS,
  codex: OPENAI_COMPATIBLE_BINDINGS,
  opencode: OPENAI_COMPATIBLE_BINDINGS,
  aider: AIDER_BINDINGS,
  gemini: GEMINI_BINDINGS,
  goose: OPENAI_COMPATIBLE_BINDINGS,
  droid: OPENAI_COMPATIBLE_BINDINGS,
  cursor: OPENAI_COMPATIBLE_BINDINGS,
} as const satisfies ProxyEnvRegistry;

function normalizeCli(cli: string): string {
  const baseCli = cli.includes(':') ? cli.split(':')[0] : cli;
  return CLI_ALIASES[baseCli] ?? baseCli;
}

function buildProxyEnv(
  bindings: readonly ProxyEnvBinding[],
  proxyUrl: string,
  proxyToken: string
): Record<string, string> {
  return bindings.reduce<Record<string, string>>((env, binding) => {
    env[binding.baseUrlVar] = proxyUrl;
    env[binding.apiKeyVar] = proxyToken;
    return env;
  }, {});
}

export function createProxyEnvResolver(registry: ProxyEnvRegistry = DEFAULT_PROXY_ENV_REGISTRY) {
  return (cli: string, proxyUrl: string, proxyToken: string): Record<string, string> => {
    const normalizedCli = normalizeCli(cli);
    const bindings = registry[normalizedCli];

    if (bindings) {
      return buildProxyEnv(bindings, proxyUrl, proxyToken);
    }

    const knownCli = getCliDefinition(normalizedCli);
    const warningPrefix = knownCli ? 'No proxy env registry entry' : 'Unknown CLI';
    console.warn(
      `[proxy-env] ${warningPrefix} for "${normalizedCli}". ` +
        'Falling back to generic OpenAI/Anthropic proxy env overrides.'
    );

    return buildProxyEnv(GENERIC_FALLBACK_BINDINGS, proxyUrl, proxyToken);
  };
}

export const resolveProxyEnv = createProxyEnvResolver();

export function resolveProxyUrlFromEnv(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env[RELAY_PROXY_URL_ENV] ?? env[RELAY_PROXY_URL_ENV_ALIAS];
}

export function resolveProxyTokenFromEnv(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env[RELAY_PROXY_TOKEN_ENV] ?? env[RELAY_PROXY_TOKEN_ENV_ALIAS];
}

export function buildNormalizedProxyEnv(proxyUrl: string, proxyToken: string): Record<string, string> {
  return {
    [RELAY_PROXY_URL_ENV]: proxyUrl,
    [RELAY_PROXY_URL_ENV_ALIAS]: proxyUrl,
    [RELAY_PROXY_TOKEN_ENV]: proxyToken,
    [RELAY_PROXY_TOKEN_ENV_ALIAS]: proxyToken,
  };
}

export function getStrippedApiKeyVars(): string[] {
  return [...STRIPPED_API_KEY_VARS];
}

export function isProxyEnabled(
  agentDef?: Pick<AgentDefinition, 'credentials'> | null,
  swarmConfig?: Pick<SwarmConfig, 'credentialProxy'> | null
): boolean {
  return Boolean(agentDef?.credentials?.proxy && swarmConfig?.credentialProxy);
}
