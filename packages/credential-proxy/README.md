# @agent-relay/credential-proxy

JWT-authenticated credential proxy for upstream LLM providers. Lets sandboxed
agents call provider APIs (OpenAI, Anthropic, OpenRouter) without being given
raw provider credentials — the proxy holds the keys, agents present per-session
JWTs, and the proxy enforces per-credential token budgets.

## What it is

A Hono app plus a handful of helpers:

- `createCredentialProxyApp(options)` — mounts the HTTP router (`/health`,
  `/usage`, and a catch-all provider-forwarding route under `*`). Use it
  directly in Node (via `@hono/node-server`) or bind it inside a Cloudflare
  Worker.
- `mintProxyToken(...)` / `verifyProxyToken(...)` — JWT helpers built on
  [`jose`](https://github.com/panva/jose). HS256 by default, audience
  `relay-llm-proxy`.
- `MeteringCollector` + `checkBudget` — in-memory usage accounting with
  pessimistic reservations so concurrent requests can't bypass the declared
  budget.
- Provider adapters under `providers/` — translate incoming JWT claims to the
  correct upstream HTTP request for OpenAI / Anthropic / OpenRouter.

## Environment variables

Required at runtime (the host of the proxy):

| Variable                            | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `CREDENTIAL_PROXY_JWT_SECRET`       | HS256 secret the proxy uses to verify per-session JWTs.      |
| `CREDENTIAL_PROXY_ADMIN_JWT_SECRET` | Secret for admin-scoped tokens (e.g. the `/usage` endpoint). |
| `CREDENTIAL_PROXY_ADMIN_AUDIENCE`   | Audience claim the proxy requires on admin tokens.           |
| `OPENAI_API_KEY`                    | Upstream credential for the OpenAI provider adapter.         |
| `ANTHROPIC_API_KEY`                 | Upstream credential for the Anthropic provider adapter.      |
| `OPENROUTER_API_KEY`                | Upstream credential for the OpenRouter provider adapter.     |

Only the provider keys you actually forward to need to be set — missing keys
surface as `502 credential_unavailable` on the relevant route.

The agent side (whichever process mints tokens and launches the sandboxed CLI)
uses `CREDENTIAL_PROXY_JWT_SECRET` to sign tokens and puts them into the agent's
environment as `CREDENTIAL_PROXY_TOKEN` (alias: `RELAY_LLM_PROXY_TOKEN`) plus
`RELAY_LLM_PROXY` / `RELAY_LLM_PROXY_URL` so the SDK's `proxy-env` helpers can
wire up per-CLI `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` overrides.

## Usage

```ts
import { serve } from '@hono/node-server';
import { createCredentialProxyApp } from '@agent-relay/credential-proxy';

const app = createCredentialProxyApp({
  // Defaults to process.env.CREDENTIAL_PROXY_JWT_SECRET / ADMIN_JWT_SECRET.
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3001) });
```

For the SDK-side wiring that lets workflow agents use the proxy transparently,
see [`@agent-relay/sdk/workflows`'s proxy-env
module](../sdk/src/workflows/proxy-env.ts) and the `credentialProxy` field on
`SwarmConfig`.

## Development

```bash
npm run build      # tsc → dist/
npm run test       # vitest
npm run dev        # builds then runs the proxy on PORT (default 3001)
```
