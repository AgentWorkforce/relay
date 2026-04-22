# Credential Proxy Integration Plan

## Overview

Integrate the credential proxy into the workflow runner so that agents receive proxy JWTs instead of raw API keys. When `credentials.proxy: true` is set on an agent, the runner mints a scoped JWT and injects proxy env vars — the agent never sees the real API key.

---

## 1. New Config Fields

### `agents[].credentials` (AgentDefinition)

Add an optional `credentials` block to `AgentDefinition` in `packages/sdk/src/workflows/types.ts`:

```typescript
export interface AgentCredentials {
  /** Opt-in to credential proxy mode. When true, the runner mints a proxy JWT
   *  and injects RELAY_LLM_PROXY_URL + RELAY_LLM_PROXY_TOKEN instead of raw keys. */
  proxy?: boolean;
  /** Override the default budget (max tokens) for this agent's proxy session. */
  budget?: number;
  /** Override which providers this agent can access (defaults to all configured). */
  providers?: ProviderType[];
}

export interface AgentDefinition {
  // ... existing fields ...
  credentials?: AgentCredentials;
}
```

### `swarm.credentialProxy` (SwarmConfig)

Add an optional `credentialProxy` block to `SwarmConfig`:

```typescript
export interface CredentialProxyConfig {
  /** The proxy endpoint URL (e.g. "https://agentrelay.com/llm-proxy"). */
  proxyUrl: string;
  /** JWT signing secret. Supports env var reference: "$RELAY_PROXY_SECRET". */
  jwtSecret: string;
  /** Default max-token budget per agent session. */
  defaultBudget?: number;
  /** Provider-to-credential mapping. */
  providers: Partial<Record<ProviderType, { credentialId: string }>>;
}

export interface SwarmConfig {
  // ... existing fields ...
  credentialProxy?: CredentialProxyConfig;
}
```

---

## 2. Runner Modifications

All changes in `packages/sdk/src/workflows/runner.ts`.

### 2a. Import credential-proxy JWT minting

```typescript
import { mintProxyToken, type ProxyTokenClaims } from '@agent-relay/credential-proxy/jwt';
```

### 2b. New instance state

```typescript
/** Minted proxy tokens keyed by agent definition name. */
private proxyTokens = new Map<string, string>();
```

### 2c. Mint tokens in `provisionAgents()` (~line 1547)

After the existing provisioning loop, add proxy token minting:

```typescript
// ── Credential proxy provisioning ──────────────────────────────────
const proxyConfig = config.swarm.credentialProxy;
if (proxyConfig) {
  for (const agent of config.agents) {
    if (!agent.credentials?.proxy) continue;

    const providers = agent.credentials.providers
      ?? (Object.keys(proxyConfig.providers) as ProviderType[]);

    // Mint one JWT per provider per agent
    // For simplicity, mint for the first configured provider.
    // Multi-provider support: mint multiple tokens or a multi-provider token.
    for (const provider of providers) {
      const providerConfig = proxyConfig.providers[provider];
      if (!providerConfig) continue;

      const claims: ProxyTokenClaims = {
        sub: `${this.workspaceId}:${agent.name}`,
        aud: 'relay-llm-proxy',
        provider,
        credentialId: providerConfig.credentialId,
        budget: agent.credentials.budget ?? proxyConfig.defaultBudget,
      };

      const secret = proxyConfig.jwtSecret.startsWith('$')
        ? process.env[proxyConfig.jwtSecret.slice(1)] ?? proxyConfig.jwtSecret
        : proxyConfig.jwtSecret;

      const token = await mintProxyToken(claims, secret);
      // Key: "agentName:provider" for multi-provider, or just agentName for single
      this.proxyTokens.set(`${agent.name}:${provider}`, token);
    }
  }
}
```

### 2d. Modify `getRelayEnv()` (~line 1535)

No changes needed here — proxy env vars are injected at the spawn site (2e/2f) rather than globally, because only proxy-enabled agents should receive them.

### 2e. Modify `execNonInteractive()` (~line 5572)

After the existing `agentToken`/`mount` injection block, add proxy env injection:

```typescript
// ── Credential proxy env injection ─────────────────────────────────
const proxyConfig = this.currentConfig?.swarm?.credentialProxy;
if (proxyConfig && agentDef.credentials?.proxy) {
  const cliOverrides = resolveCliBaseUrlOverrides(agentDef.cli, proxyConfig.proxyUrl);
  Object.assign(env, cliOverrides);

  // Inject proxy token(s) — find all tokens for this agent
  for (const [key, token] of this.proxyTokens) {
    if (key.startsWith(`${agentDef.name}:`)) {
      const provider = key.split(':')[1];
      env[`RELAY_LLM_PROXY_TOKEN_${provider.toUpperCase()}`] = token;
    }
  }
  env.RELAY_LLM_PROXY_URL = proxyConfig.proxyUrl;

  // Strip raw API keys so the agent can't bypass the proxy
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENROUTER_API_KEY;
}
```

### 2f. Modify `spawnAndWait()` (~line 5831)

In the `spawnOptions` construction, pass proxy env via the spawn options:

```typescript
const spawnEnvOverrides: Record<string, string> = {};
const proxyConfig = this.currentConfig?.swarm?.credentialProxy;
if (proxyConfig && agentDef.credentials?.proxy) {
  const cliOverrides = resolveCliBaseUrlOverrides(agentDef.cli, proxyConfig.proxyUrl);
  Object.assign(spawnEnvOverrides, cliOverrides);

  for (const [key, token] of this.proxyTokens) {
    if (key.startsWith(`${agentDef.name}:`)) {
      const provider = key.split(':')[1];
      spawnEnvOverrides[`RELAY_LLM_PROXY_TOKEN_${provider.toUpperCase()}`] = token;
    }
  }
  spawnEnvOverrides.RELAY_LLM_PROXY_URL = proxyConfig.proxyUrl;
}

// Pass spawnEnvOverrides into spawnOptions.env (needs relay.spawnPty to accept env)
```

### 2g. Modify `filteredEnv()` (~line 150)

Add a `stripApiKeys` parameter:

```typescript
function filteredEnv(
  extra?: Record<string, string | undefined>,
  options?: { stripApiKeys?: boolean }
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const stripKeys = new Set(
    options?.stripApiKeys
      ? ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']
      : []
  );
  for (const key of ENV_ALLOWLIST) {
    if (stripKeys.has(key)) continue;
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}
```

Note: Currently none of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY` are in the `ENV_ALLOWLIST` (line 113-147), so they already do NOT propagate through `filteredEnv()`. They would only leak through `getRelayEnv()` which spreads `...process.env`. The `delete` statements in 2e handle this case.

---

## 3. CLI Base URL Override Registry

New file: `packages/sdk/src/workflows/cli-proxy-overrides.ts`

Each coding agent CLI uses different env vars to override the LLM API base URL. The proxy works by redirecting these base URLs to the proxy endpoint.

```typescript
import type { AgentCli } from './types.js';

/** Maps CLI name -> env var overrides needed to redirect LLM calls through the proxy. */
const CLI_BASE_URL_OVERRIDES: Record<string, (proxyUrl: string) => Record<string, string>> = {
  // Claude Code
  claude: (url) => ({
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: 'proxy',  // Claude Code requires a non-empty key
  }),

  // OpenAI Codex CLI
  codex: (url) => ({
    OPENAI_BASE_URL: url,
    OPENAI_API_KEY: 'proxy',
  }),

  // OpenCode
  opencode: (url) => ({
    OPENAI_BASE_URL: url,
    OPENAI_API_KEY: 'proxy',
  }),

  // Aider
  aider: (url) => ({
    OPENAI_API_BASE: url,
    OPENAI_API_KEY: 'proxy',
  }),

  // Gemini CLI
  gemini: (url) => ({
    GOOGLE_API_BASE: url,
  }),

  // Goose (uses OpenAI-compatible endpoint)
  goose: (url) => ({
    OPENAI_BASE_URL: url,
    OPENAI_API_KEY: 'proxy',
  }),

  // Droid (uses OpenAI-compatible endpoint)
  droid: (url) => ({
    OPENAI_BASE_URL: url,
    OPENAI_API_KEY: 'proxy',
  }),

  // Cursor / Cursor Agent (uses OpenAI-compatible endpoint)
  cursor: (url) => ({
    OPENAI_BASE_URL: url,
    OPENAI_API_KEY: 'proxy',
  }),
  'cursor-agent': (url) => ({
    OPENAI_BASE_URL: url,
    OPENAI_API_KEY: 'proxy',
  }),
};

/** Generic fallback: set both major provider base URLs. */
const GENERIC_FALLBACK = (url: string): Record<string, string> => ({
  OPENAI_BASE_URL: url,
  ANTHROPIC_BASE_URL: url,
  OPENAI_API_KEY: 'proxy',
  ANTHROPIC_API_KEY: 'proxy',
});

/**
 * Resolve the env var overrides needed to route a CLI's LLM calls through the proxy.
 *
 * @param cli - The agent CLI type (e.g. "claude", "codex", "aider")
 * @param proxyUrl - The credential proxy endpoint URL
 * @returns Record of env vars to inject into the agent's environment
 */
export function resolveCliBaseUrlOverrides(
  cli: AgentCli | string,
  proxyUrl: string
): Record<string, string> {
  const resolver = CLI_BASE_URL_OVERRIDES[cli] ?? GENERIC_FALLBACK;
  return resolver(proxyUrl);
}
```

---

## 4. Workflow Config Example

```yaml
version: "1"
name: multi-agent-with-proxy
description: Agents use credential proxy instead of raw API keys

swarm:
  pattern: fan-out
  credentialProxy:
    proxyUrl: "https://agentrelay.com/llm-proxy"
    jwtSecret: "$RELAY_PROXY_SECRET"  # resolved from env
    defaultBudget: 100000
    providers:
      anthropic:
        credentialId: "nango-anthropic-prod"
      openai:
        credentialId: "nango-openai-prod"
      openrouter:
        credentialId: "nango-openrouter-prod"

agents:
  - name: generator
    cli: claude
    role: "Code generator"
    credentials:
      proxy: true  # opt-in to proxy mode
    # Agent receives ANTHROPIC_BASE_URL pointing to proxy
    # and a scoped JWT — never sees the real Anthropic key

  - name: reviewer
    cli: codex
    role: "Code reviewer"
    credentials:
      proxy: true
      budget: 50000  # override default budget
    # Agent receives OPENAI_BASE_URL pointing to proxy

  - name: legacy-agent
    cli: aider
    role: "Legacy helper"
    # No credentials.proxy — gets normal env, no proxy
```

---

## 5. Data Flow

```
relay.yaml                    Runner                         Agent Process
─────────                    ──────                         ─────────────
credentialProxy config ──→ provisionAgents()
                            │
                            ├─ for each agent w/ proxy:true
                            │   └─ mintProxyToken(claims, secret) ──→ JWT
                            │
                            ├─ spawnAndWait() / execNonInteractive()
                            │   ├─ resolveCliBaseUrlOverrides(cli, proxyUrl)
                            │   ├─ inject RELAY_LLM_PROXY_URL
                            │   ├─ inject RELAY_LLM_PROXY_TOKEN_<PROVIDER>
                            │   ├─ inject CLI-specific base URL overrides
                            │   └─ strip raw API keys from env
                            │
                            └─ Agent spawns with proxy env ──→  CLI makes API call
                                                                  │
                                                                  ├─ Base URL → proxy
                                                                  ├─ Proxy validates JWT
                                                                  ├─ Proxy fetches real
                                                                  │  credential from Nango
                                                                  └─ Proxy forwards to
                                                                     real provider API
```

---

## 6. Backwards Compatibility

- **No `credentialProxy` in swarm config**: Zero behavior change. No proxy tokens minted.
- **No `credentials.proxy` on agent**: Zero behavior change. Agent gets normal env.
- **Mixed mode**: Some agents use proxy, others don't. Each agent's env is independent.
- **`filteredEnv()` unchanged**: Raw API keys are already excluded from the allowlist. Only `getRelayEnv()` (which spreads `process.env`) could leak them, and the proxy injection code explicitly deletes them.

---

## 7. Security Considerations

- **JWT scope**: Each token is scoped to one agent + one provider + one credential. An agent cannot use another agent's token for a different provider.
- **Budget enforcement**: The proxy validates budget claims and rejects requests that exceed the token's budget.
- **Key stripping**: Raw API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) are deleted from the agent's env when proxy mode is active, preventing bypass.
- **Secret resolution**: `jwtSecret` supports `$ENV_VAR` syntax so the secret never appears in YAML files.
- **Token TTL**: Tokens use the 15-minute default TTL from `DEFAULT_PROXY_TOKEN_TTL_SECONDS`. For long-running agents, the runner should refresh tokens (future enhancement).

---

## 8. Files to Modify

| File | Change |
|------|--------|
| `packages/sdk/src/workflows/types.ts` | Add `AgentCredentials`, `CredentialProxyConfig`, update `AgentDefinition` and `SwarmConfig` |
| `packages/sdk/src/workflows/runner.ts` | Import proxy JWT, add `proxyTokens` map, modify `provisionAgents()`, `execNonInteractive()`, `spawnAndWait()` |
| `packages/sdk/src/workflows/cli-proxy-overrides.ts` | **New file** — CLI base URL override registry |
| `packages/sdk/src/workflows/schema.json` | Add `credentialProxy` and `credentials` to validation schema |

---

## 9. Implementation Order

1. **Types first** — Add `AgentCredentials` and `CredentialProxyConfig` to `types.ts`
2. **CLI overrides** — Create `cli-proxy-overrides.ts` with the resolver registry
3. **Runner integration** — Wire up minting + env injection in `runner.ts`
4. **Schema update** — Add new fields to `schema.json` for YAML validation
5. **Tests** — Unit tests for `resolveCliBaseUrlOverrides()`, integration tests for env injection
