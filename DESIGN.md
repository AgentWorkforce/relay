# Credential Proxy — Design Document

## Problem

Nango runs AI agents in sandboxes that need LLM API access (OpenRouter, Anthropic, OpenAI). Today, raw API keys are passed as environment variables — agents can exfiltrate them. LiteLLM was rejected (heavy Python server). We need a lightweight, transparent proxy that:

- Hides real API keys from sandbox agents
- Validates short-lived JWTs instead of long-lived secrets
- Forwards LLM requests unchanged (agents don't know they're proxied)
- Meters token usage per workspace/session

---

## Package Location

```
packages/credential-proxy/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Hono app factory + exports
│   ├── router.ts             # Route definitions (/v1/chat/completions, /v1/messages)
│   ├── jwt.ts                # JWT validation, claims extraction
│   ├── credential-store.ts   # Interface to relay's encrypted credential storage
│   ├── metering.ts           # Token usage extraction and recording
│   ├── providers/
│   │   ├── types.ts          # ProviderAdapter interface
│   │   ├── openai.ts         # OpenAI adapter
│   │   ├── anthropic.ts      # Anthropic adapter
│   │   └── openrouter.ts     # OpenRouter adapter
│   └── errors.ts             # Error types and HTTP error responses
├── test/
│   ├── jwt.test.ts
│   ├── router.test.ts
│   ├── metering.test.ts
│   └── providers/
│       ├── openai.test.ts
│       ├── anthropic.test.ts
│       └── openrouter.test.ts
└── README.md
```

Follows the same structure as `packages/gateway/` — Hono replaces the raw HTTP handling, but the adapter dispatch pattern is identical.

---

## JWT Claims Schema

```typescript
export interface ProxyJwtClaims {
  /** Workspace ID (e.g., "wks_abc123") */
  sub: string;

  /** Fixed audience — must be "relay-llm-proxy" */
  aud: "relay-llm-proxy";

  /** LLM provider this token authorizes */
  provider: "openai" | "anthropic" | "openrouter";

  /** Reference to encrypted credential in relay's credential store */
  credentialId: string;

  /** Optional max tokens for this session (input + output combined) */
  budget?: number;

  /** Issued-at (unix seconds) */
  iat: number;

  /** Expiration (unix seconds) — default 15 min TTL */
  exp: number;

  /** Unique token ID for audit trail */
  jti: string;

  /** Issuer — "relay-credential-proxy" */
  iss: string;
}
```

**TTL policy:** 15 minutes default. Tokens are minted by the relay cloud API when a sandbox session starts. The sandbox receives only the JWT — never the underlying API key.

**Signing:** HMAC-SHA256, following the pattern in `packages/sdk/src/provisioner/token.ts`. The signing secret is a per-workspace key stored in relay cloud, not in the proxy itself. The proxy receives the verification secret via environment variable or runtime config.

---

## Request Flow

```
Agent (sandbox)
  │
  │  POST /v1/chat/completions  (or /v1/messages)
  │  Authorization: Bearer <jwt>
  │
  ▼
┌─────────────────────────────┐
│  Credential Proxy (Hono)    │
│                             │
│  1. Extract JWT from header │
│  2. Validate signature+exp  │
│  3. Check budget (if set)   │
│  4. Resolve real API key    │
│     via credentialId        │
│  5. Select provider adapter │
│  6. Forward request with    │
│     real API key            │
│  7. Stream response back    │
│  8. Extract token usage     │
│  9. Record metering event   │
└─────────────────────────────┘
  │
  ▼
Provider API (OpenAI / Anthropic / OpenRouter)
```

---

## Provider Adapter Pattern

Mirrors `packages/gateway/src/types.ts` — each surface adapter normalizes inbound/outbound messages. Here, each provider adapter normalizes auth headers and usage extraction.

```typescript
// src/providers/types.ts

export interface ProviderAdapter {
  /** Provider identifier */
  readonly type: "openai" | "anthropic" | "openrouter";

  /** The upstream base URL for this provider */
  readonly baseUrl: string;

  /**
   * Build the outgoing request headers.
   * Replaces the proxy JWT with the real API key in the
   * provider-specific auth header format.
   */
  buildHeaders(apiKey: string, incomingHeaders: Headers): Headers;

  /**
   * Map the incoming proxy path to the upstream provider path.
   * e.g., /v1/chat/completions → /v1/chat/completions (OpenAI)
   *        /v1/messages → /v1/messages (Anthropic)
   */
  upstreamPath(proxyPath: string): string;

  /**
   * Extract token usage from the provider's response body.
   * Called after the full response is buffered (non-streaming)
   * or after the stream ends (streaming).
   */
  extractUsage(responseBody: unknown): TokenUsage | null;

  /**
   * Extract token usage from a streaming chunk (SSE data).
   * Returns null for non-final chunks. Returns usage from the
   * final chunk that includes it (e.g., OpenAI's last chunk
   * with usage field, Anthropic's message_stop event).
   */
  extractStreamingUsage(chunk: string): TokenUsage | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
}
```

### Adapter Implementations

**OpenAI** (`src/providers/openai.ts`):
- Base URL: `https://api.openai.com`
- Auth header: `Authorization: Bearer <key>`
- Path: `/v1/chat/completions` (passthrough)
- Usage: `response.usage.prompt_tokens`, `response.usage.completion_tokens`
- Streaming: final SSE chunk contains `usage` when `stream_options.include_usage` is set; proxy injects this option

**Anthropic** (`src/providers/anthropic.ts`):
- Base URL: `https://api.anthropic.com`
- Auth header: `x-api-key: <key>` (NOT Bearer)
- Also sets: `anthropic-version: 2023-06-01`
- Path: `/v1/messages` (passthrough)
- Usage: `response.usage.input_tokens`, `response.usage.output_tokens`
- Streaming: `message_delta` event contains `usage` in the final event

**OpenRouter** (`src/providers/openrouter.ts`):
- Base URL: `https://openrouter.ai/api`
- Auth header: `Authorization: Bearer <key>`
- Path: `/v1/chat/completions` (passthrough — OpenAI-compatible)
- Usage: `response.usage.prompt_tokens`, `response.usage.completion_tokens`
- Streaming: same as OpenAI format

---

## Router Design

```typescript
// src/router.ts

import { Hono } from "hono";
import type { ProxyJwtClaims } from "./jwt.js";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// OpenAI-compatible endpoint
app.post("/v1/chat/completions", jwtMiddleware, proxyHandler);

// Anthropic-compatible endpoint
app.post("/v1/messages", jwtMiddleware, proxyHandler);
```

**Route → Provider mapping:**
- `/v1/chat/completions` → uses `claims.provider` to select OpenAI or OpenRouter adapter
- `/v1/messages` → Anthropic adapter (validated against `claims.provider === "anthropic"`)

If the route doesn't match the JWT's `provider` claim, return 400.

**jwtMiddleware** extracts and validates the JWT, attaches claims to context:
```typescript
async function jwtMiddleware(c: Context, next: Next) {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "Missing authorization" }, 401);

  const claims = await validateJwt(token, signingSecret);
  c.set("claims", claims);
  await next();
}
```

**proxyHandler** orchestrates the forward-and-stream:
```typescript
async function proxyHandler(c: Context) {
  const claims = c.get("claims") as ProxyJwtClaims;
  const adapter = resolveAdapter(claims.provider);
  const apiKey = await credentialStore.resolve(claims.credentialId);

  // Budget check
  if (claims.budget) {
    const used = await metering.getSessionUsage(claims.jti);
    if (used >= claims.budget) {
      return c.json({ error: "Token budget exceeded" }, 429);
    }
  }

  // Build upstream request
  const headers = adapter.buildHeaders(apiKey, c.req.raw.headers);
  const upstreamUrl = `${adapter.baseUrl}${adapter.upstreamPath(c.req.path)}`;
  const body = await c.req.text();

  const isStreaming = JSON.parse(body).stream === true;

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body,
  });

  if (!upstream.ok) {
    // Pass through provider errors unchanged
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  if (isStreaming) {
    return streamResponse(c, upstream, adapter, claims);
  } else {
    return bufferedResponse(c, upstream, adapter, claims);
  }
}
```

### Streaming Strategy

For streaming responses, the proxy pipes SSE chunks through unchanged, but taps each chunk to detect usage:

```typescript
async function streamResponse(c, upstream, adapter, claims) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  let finalUsage: TokenUsage | null = null;

  // Pipe in background
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      const usage = adapter.extractStreamingUsage(text);
      if (usage) finalUsage = usage;
      await writer.write(value);  // Pass through unchanged
    }
    writer.close();

    // Record usage after stream ends
    if (finalUsage) {
      await metering.record(claims, finalUsage);
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}
```

---

## JWT Validation

```typescript
// src/jwt.ts

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProxyJwtClaims } from "./providers/types.js";

const ALLOWED_AUDIENCES = ["relay-llm-proxy"] as const;
const CLOCK_SKEW_SECONDS = 30;

export function validateJwt(token: string, secret: string): ProxyJwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("Malformed token");

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Verify signature (HMAC-SHA256, timing-safe)
  const unsigned = `${headerB64}.${payloadB64}`;
  const expected = createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");

  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signatureB64))) {
    throw new JwtError("Invalid signature");
  }

  // 2. Decode and parse
  const header = JSON.parse(base64urlDecode(headerB64));
  if (header.alg !== "HS256") throw new JwtError("Unsupported algorithm");

  const claims = JSON.parse(base64urlDecode(payloadB64)) as ProxyJwtClaims;

  // 3. Validate standard claims
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now - CLOCK_SKEW_SECONDS) {
    throw new JwtError("Token expired");
  }
  if (claims.aud !== "relay-llm-proxy") {
    throw new JwtError("Invalid audience");
  }
  if (!["openai", "anthropic", "openrouter"].includes(claims.provider)) {
    throw new JwtError("Invalid provider");
  }

  return claims;
}
```

Follows the same HMAC-SHA256 + `timingSafeEqual` pattern used in `packages/sdk/src/provisioner/token.ts` and `packages/gateway/src/adapters/slack.ts`.

---

## Credential Store Integration

The proxy resolves real API keys via `credentialId` from the JWT claims. This integrates with relay cloud's encrypted credential storage (`packages/cloud/src/`).

```typescript
// src/credential-store.ts

export interface CredentialStore {
  /**
   * Resolve a credentialId to the decrypted API key.
   * The credentialId is an opaque reference stored in the JWT claims.
   * The actual key is encrypted at rest in relay cloud (S3 + KMS).
   */
  resolve(credentialId: string): Promise<string>;
}
```

### Implementation Options

**Option A — API call to relay cloud** (recommended for production):
```typescript
export class CloudCredentialStore implements CredentialStore {
  constructor(
    private readonly apiUrl: string,
    private readonly serviceToken: string,
  ) {}

  async resolve(credentialId: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}/api/v1/credentials/${credentialId}`, {
      headers: { authorization: `Bearer ${this.serviceToken}` },
    });
    if (!res.ok) throw new CredentialError(`Failed to resolve: ${res.status}`);
    const { apiKey } = await res.json();
    return apiKey;
  }
}
```

This follows the same pattern as `packages/cloud/src/auth.ts` — the proxy never holds decryption keys; cloud API decrypts via KMS and returns the plaintext key over a TLS-protected internal channel.

**Option B — Local cache with TTL** (for performance):
```typescript
export class CachedCredentialStore implements CredentialStore {
  private cache = new Map<string, { key: string; expiresAt: number }>();
  private readonly ttlMs = 5 * 60 * 1000; // 5 min cache

  constructor(private readonly inner: CredentialStore) {}

  async resolve(credentialId: string): Promise<string> {
    const cached = this.cache.get(credentialId);
    if (cached && cached.expiresAt > Date.now()) return cached.key;

    const key = await this.inner.resolve(credentialId);
    this.cache.set(credentialId, { key, expiresAt: Date.now() + this.ttlMs });
    return key;
  }
}
```

The cache must be bounded (LRU or size cap) and the TTL kept short since credentials can be rotated.

---

## Metering Data Model

```typescript
// src/metering.ts

export interface MeteringEvent {
  /** Unique event ID */
  id: string;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** From JWT claims */
  workspaceId: string;     // claims.sub
  provider: string;        // claims.provider
  credentialId: string;    // claims.credentialId
  tokenId: string;         // claims.jti (for budget tracking)

  /** From provider response */
  model: string;           // e.g., "gpt-4o", "claude-sonnet-4-20250514"
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  /** Request metadata */
  streaming: boolean;
  statusCode: number;
  latencyMs: number;
}
```

### Recording Strategy

**Phase 1 — Append to local log** (simple, works everywhere):
```typescript
export class MeteringRecorder {
  async record(claims: ProxyJwtClaims, usage: TokenUsage, meta: RequestMeta): Promise<void> {
    const event: MeteringEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      workspaceId: claims.sub,
      provider: claims.provider,
      credentialId: claims.credentialId,
      tokenId: claims.jti,
      model: usage.model ?? "unknown",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      streaming: meta.streaming,
      statusCode: meta.statusCode,
      latencyMs: meta.latencyMs,
    };
    // Emit to configured sink (stdout JSON line, or POST to metering API)
    this.sink.emit(event);
  }

  async getSessionUsage(tokenId: string): Promise<number> {
    // Sum totalTokens for this jti (for budget enforcement)
    return this.sink.sumByTokenId(tokenId);
  }
}
```

**Phase 2 — Push to relay cloud metering API** (for billing):
- Batch events and flush every N seconds or N events
- POST to `/api/v1/metering/events`
- Cloud aggregates per workspace for billing

**Metering sinks** (pluggable):
- `StdoutSink` — JSON lines to stdout (Lambda CloudWatch / local dev)
- `ApiSink` — POST to relay cloud metering endpoint
- `InMemorySink` — for tests and budget enforcement in single-process mode

---

## Error Handling

| Error Condition | HTTP Status | Response Body |
|---|---|---|
| Missing Authorization header | 401 | `{ "error": "Missing authorization" }` |
| Malformed JWT | 401 | `{ "error": "Malformed token" }` |
| Invalid JWT signature | 401 | `{ "error": "Invalid signature" }` |
| Expired JWT | 401 | `{ "error": "Token expired" }` |
| Wrong audience claim | 401 | `{ "error": "Invalid audience" }` |
| Provider mismatch (route vs claim) | 400 | `{ "error": "Provider mismatch" }` |
| Credential not found | 502 | `{ "error": "Credential resolution failed" }` |
| Budget exceeded | 429 | `{ "error": "Token budget exceeded" }` |
| Provider returns error | pass-through | Provider's original error response |
| Provider unreachable | 502 | `{ "error": "Upstream unreachable" }` |
| Provider rate limit (429) | 429 | Provider's original 429 response |

**Design principle:** Provider errors are passed through unchanged. The agent SDK already handles OpenAI/Anthropic error formats — the proxy should not transform them. Only proxy-level errors (JWT, budget, credential resolution) use the proxy's own error format.

```typescript
// src/errors.ts

export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

export class JwtError extends ProxyError {
  constructor(message: string) {
    super(message, 401, "jwt_error");
  }
}

export class CredentialError extends ProxyError {
  constructor(message: string) {
    super(message, 502, "credential_error");
  }
}

export class BudgetExceededError extends ProxyError {
  constructor() {
    super("Token budget exceeded", 429, "budget_exceeded");
  }
}
```

Hono error handler catches `ProxyError` and returns structured JSON:
```typescript
app.onError((err, c) => {
  if (err instanceof ProxyError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  console.error("Unexpected error:", err);
  return c.json({ error: "Internal server error" }, 500);
});
```

---

## Deployment Targets

Hono runs on all of these with zero code changes:

| Target | Entry Point | Notes |
|---|---|---|
| **Node.js** | `hono/node-server` | Local dev, Docker, EC2 |
| **AWS Lambda** | `hono/aws-lambda` | Nango's likely deployment |
| **Cloudflare Workers** | `hono/cloudflare-workers` | Edge deployment |

The `src/index.ts` exports the Hono app; the deployment adapter wraps it:

```typescript
// src/index.ts
export { createProxy } from "./router.js";

// For Node.js standalone:
// import { serve } from '@hono/node-server';
// import { createProxy } from './index.js';
// serve({ fetch: createProxy({ ... }).fetch, port: 3001 });
```

---

## Security Considerations

1. **No key exposure** — API keys never leave the proxy process. They are fetched from the credential store, used in the upstream request, and discarded. Never logged.

2. **Short-lived tokens** — 15 min default TTL. Even if a JWT leaks, the blast radius is time-bounded and budget-capped.

3. **Budget enforcement** — Optional per-session token budget prevents runaway costs from compromised or buggy agents.

4. **Timing-safe comparison** — JWT signature validation uses `timingSafeEqual` to prevent timing attacks (same pattern as gateway's Slack signature verification).

5. **No credential caching without TTL** — If caching is enabled, it's bounded and short-lived. Credential rotation takes effect within the cache TTL.

6. **Provider error passthrough** — The proxy doesn't leak internal state in error messages. Provider errors are forwarded as-is; proxy errors use minimal, fixed messages.

7. **Audit trail** — Every request is metered with workspace, provider, model, and token ID. Combined with JWT `jti`, this enables per-session forensics.

---

## Integration with Existing Packages

| Package | Integration |
|---|---|
| `packages/sdk` | JWT minting functions extended to mint proxy tokens; `TokenClaims` type extended with proxy-specific fields |
| `packages/cloud` | Credential store API serves decrypted keys to the proxy; new `/api/v1/credentials/:id` endpoint |
| `packages/gateway` | No direct integration; shared adapter pattern for consistency |
| `packages/config` | Proxy configuration (signing secret, credential store URL) follows existing config patterns |

---

## Open Questions

1. **Multi-region credential store** — Should the proxy cache credentials regionally, or always call the central credential store? Latency vs. consistency tradeoff.

2. **Token renewal** — Should the proxy support a `/v1/token/refresh` endpoint, or should the orchestrator (Nango) mint new tokens directly from relay cloud?

3. **Model allowlisting** — Should the JWT claims include an allowed model list, or is provider-level access sufficient?

4. **Request body inspection** — Should the proxy inspect/modify request bodies (e.g., inject `stream_options.include_usage` for OpenAI), or keep the body strictly opaque?
