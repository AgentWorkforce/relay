import './crypto-polyfill.js';
import { randomUUID } from 'node:crypto';

import { errors as joseErrors, jwtVerify } from 'jose';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { stream } from 'hono/streaming';

import { MeteringCollector, checkBudget, DEFAULT_BUDGET_RESERVATION } from './metering.js';
import { TokenExpiredError, TokenInvalidError, verifyProxyToken } from './jwt.js';
import { resolveProviderByName } from './providers/index.js';
import { waitForCapturedUsage, type TokenUsage } from './providers/types.js';
import type {
  AdminTokenClaims,
  MeteringRecord,
  ProviderType,
  ProxyTokenClaims,
  UsageSummary,
} from './types.js';

const encoder = new TextEncoder();

const DEFAULT_ADMIN_AUDIENCE = 'relay-credential-proxy-admin';
const PROVIDER_API_KEY_ENV: Record<ProviderType, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

type AppEnv = {
  Variables: CredentialProxyVariables;
};

export interface CredentialProxyVariables {
  requestId: string;
  claims: ProxyTokenClaims;
  adminClaims: AdminTokenClaims;
}

export interface CredentialStore {
  resolve(claims: ProxyTokenClaims): Promise<string>;
}

export interface CredentialProxyOptions {
  jwtSecret?: string;
  adminJwtSecret?: string;
  adminAudience?: string;
  metering?: MeteringCollector;
  credentialStore?: CredentialStore;
  requestIdFactory?: () => string;
}

export type CredentialProxyApp = Hono<AppEnv>;

class ProxyHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, options?: { expose?: boolean }) {
    super(message);
    this.name = 'ProxyHttpError';
    this.status = status;
    this.code = code;
    this.expose = options?.expose ?? true;
  }
}

class EnvCredentialStore implements CredentialStore {
  async resolve(claims: ProxyTokenClaims): Promise<string> {
    const envName = PROVIDER_API_KEY_ENV[claims.provider];
    const apiKey = process.env[envName];

    if (!apiKey) {
      throw new ProxyHttpError(
        502,
        'credential_unavailable',
        `No upstream credential configured for provider ${claims.provider}`
      );
    }

    return apiKey;
  }
}

export function createCredentialStore(): CredentialStore {
  return new EnvCredentialStore();
}

export function createCredentialProxyApp(options: CredentialProxyOptions = {}): CredentialProxyApp {
  const metering = options.metering ?? new MeteringCollector();
  const credentialStore = options.credentialStore ?? createCredentialStore();
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  const app = new Hono<AppEnv>();

  app.use('*', createRequestIdMiddleware(requestIdFactory));
  app.onError((error, c) => createErrorResponse(c, error));

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      requestId: c.get('requestId'),
    })
  );

  app.get('/usage', adminJwtMiddleware(options), (c) => {
    const workspaceId = c.req.query('workspaceId');
    const credentialId = c.req.query('credentialId');
    const usage = selectUsageSummary(metering, workspaceId, credentialId);

    return c.json({
      requestId: c.get('requestId'),
      usage,
      filters: {
        workspaceId: workspaceId ?? null,
        credentialId: credentialId ?? null,
      },
      viewer: c.get('adminClaims').sub,
    });
  });

  app.all('*', proxyJwtMiddleware(options), async (c) => {
    const claims = c.get('claims');
    const adapter = resolveProviderByName(claims.provider);

    if (!adapter.matchesPath(c.req.path)) {
      throw new ProxyHttpError(
        400,
        'route_provider_mismatch',
        `Path ${c.req.path} is not valid for provider ${claims.provider}`
      );
    }

    const budgetCheck = checkBudget(claims, metering);
    if (!budgetCheck.allowed) {
      throw new ProxyHttpError(429, 'budget_exceeded', 'Token budget exceeded');
    }

    // Reserve pessimistic budget to prevent concurrent requests from bypassing limits.
    const reservation = claims.budget !== undefined ? DEFAULT_BUDGET_RESERVATION : 0;
    if (reservation > 0) {
      metering.reservePending(claims.sub, reservation);
    }

    try {
      const apiKey = await credentialStore.resolve(claims);
      const startedAt = Date.now();
      const upstreamResponse = await adapter.forwardRequest(c.req.raw, apiKey);

      if (isStreamingResponse(upstreamResponse)) {
        applyResponseHeaders(c, upstreamResponse.headers);
        c.status(upstreamResponse.status as never);

        return stream(
          c,
          async (output) => {
            try {
              if (upstreamResponse.body) {
                try {
                  await output.pipe(upstreamResponse.body);
                } catch (error) {
                  if (!output.aborted) {
                    throw error;
                  }
                }
              }

              if (!output.aborted) {
                await recordUsage(metering, c, claims, upstreamResponse, startedAt);
              }
            } finally {
              if (reservation > 0) {
                metering.releasePending(claims.sub, reservation);
              }
            }
          },
          async (error) => {
            if (reservation > 0) {
              metering.releasePending(claims.sub, reservation);
            }
            console.error(`[credential-proxy] streaming failed requestId=${c.get('requestId')}`, error);
          }
        );
      }

      await recordUsage(metering, c, claims, upstreamResponse, startedAt);
      if (reservation > 0) {
        metering.releasePending(claims.sub, reservation);
      }
      return upstreamResponse;
    } catch (error) {
      if (reservation > 0) {
        metering.releasePending(claims.sub, reservation);
      }
      throw error;
    }
  });

  return app;
}

export const app = createCredentialProxyApp();

function createRequestIdMiddleware(requestIdFactory: () => string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = requestIdFactory();
    c.set('requestId', requestId);

    await next();

    c.res.headers.set('x-request-id', requestId);
  };
}

function proxyJwtMiddleware(options: CredentialProxyOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header('authorization'));
    if (!token) {
      throw new ProxyHttpError(401, 'missing_authorization', 'Missing bearer token');
    }

    const claims = await verifyProxyToken(token, getProxyJwtSecret(options));
    c.set('claims', claims);
    await next();
  };
}

function adminJwtMiddleware(options: CredentialProxyOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header('authorization'));
    if (!token) {
      throw new ProxyHttpError(401, 'missing_authorization', 'Missing bearer token');
    }

    const claims = await verifyAdminToken(
      token,
      getAdminJwtSecret(options),
      options.adminAudience ?? process.env.CREDENTIAL_PROXY_ADMIN_AUDIENCE ?? DEFAULT_ADMIN_AUDIENCE
    );
    c.set('adminClaims', claims);
    await next();
  };
}

async function verifyAdminToken(token: string, secret: string, audience: string): Promise<AdminTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      algorithms: ['HS256'],
      audience,
    });

    const claims = normalizeAdminClaims(payload as Record<string, unknown>);
    if (!hasUsageReadAccess(claims)) {
      throw new ProxyHttpError(403, 'admin_required', 'Admin token required');
    }

    return claims;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new TokenExpiredError('Admin token expired', { cause: error });
    }

    if (error instanceof ProxyHttpError) {
      throw error;
    }

    throw new TokenInvalidError('Admin token is invalid', { cause: error });
  }
}

function normalizeAdminClaims(payload: Record<string, unknown>): AdminTokenClaims {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new TokenInvalidError('Admin token subject is invalid');
  }

  return {
    sub: payload.sub,
    ...(payload.aud === undefined ? {} : { aud: payload.aud as string | string[] }),
    ...(typeof payload.exp === 'number' ? { exp: payload.exp } : {}),
    ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
    ...(typeof payload.iss === 'string' ? { iss: payload.iss } : {}),
    ...(typeof payload.role === 'string' ? { role: payload.role } : {}),
    ...(Array.isArray(payload.permissions)
      ? {
          permissions: payload.permissions.filter(
            (value): value is string => typeof value === 'string' && value.length > 0
          ),
        }
      : {}),
    ...(typeof payload.scope === 'string' || Array.isArray(payload.scope)
      ? { scope: payload.scope as string | string[] }
      : {}),
  };
}

function hasUsageReadAccess(claims: AdminTokenClaims): boolean {
  if (claims.role === 'admin') {
    return true;
  }

  const scopes = Array.isArray(claims.scope)
    ? claims.scope
    : typeof claims.scope === 'string'
      ? claims.scope.split(/\s+/)
      : [];

  return (
    claims.permissions?.includes('usage:read') === true ||
    scopes.includes('usage:read') ||
    scopes.includes('admin')
  );
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function getProxyJwtSecret(options: CredentialProxyOptions): string {
  const secret = options.jwtSecret ?? process.env.CREDENTIAL_PROXY_JWT_SECRET ?? process.env.PROXY_JWT_SECRET;

  if (!secret) {
    throw new ProxyHttpError(500, 'configuration_error', 'Proxy JWT secret is not configured', {
      expose: false,
    });
  }

  return secret;
}

function getAdminJwtSecret(options: CredentialProxyOptions): string {
  const secret =
    options.adminJwtSecret ??
    process.env.CREDENTIAL_PROXY_ADMIN_JWT_SECRET ??
    options.jwtSecret ??
    process.env.CREDENTIAL_PROXY_JWT_SECRET ??
    process.env.PROXY_JWT_SECRET;

  if (!secret) {
    throw new ProxyHttpError(500, 'configuration_error', 'Admin JWT secret is not configured', {
      expose: false,
    });
  }

  return secret;
}

function selectUsageSummary(
  metering: MeteringCollector,
  workspaceId?: string,
  credentialId?: string
): UsageSummary {
  if (workspaceId) {
    return metering.getUsageByWorkspace(workspaceId);
  }

  if (credentialId) {
    return metering.getUsageByCredential(credentialId);
  }

  return metering.getTotalUsage();
}

function isStreamingResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return Boolean(response.body) && contentType.includes('text/event-stream');
}

function applyResponseHeaders(c: Context<AppEnv>, headers: Headers): void {
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-length') {
      return;
    }

    c.header(key, value);
  });
}

async function recordUsage(
  metering: MeteringCollector,
  c: Context<AppEnv>,
  claims: ProxyTokenClaims,
  response: Response,
  startedAt: number
): Promise<void> {
  if (!response.ok) {
    return;
  }

  const usage = await waitForCapturedUsage(response);
  if (!usage) {
    return;
  }

  metering.record(createMeteringRecord(c.get('requestId'), claims, c.req.path, usage, startedAt));
}

function createMeteringRecord(
  requestId: string,
  claims: ProxyTokenClaims,
  endpoint: string,
  usage: TokenUsage,
  startedAt: number
): MeteringRecord {
  return {
    requestId,
    workspaceId: claims.sub,
    provider: claims.provider,
    credentialId: claims.credentialId,
    endpoint,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    timestamp: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function createErrorResponse(c: Context<AppEnv>, error: unknown): Response {
  const requestId = c.get('requestId');

  if (error instanceof TokenExpiredError) {
    return c.json(
      {
        error: 'Token expired',
        code: 'token_expired',
        requestId,
      },
      401
    );
  }

  if (error instanceof TokenInvalidError) {
    return c.json(
      {
        error: 'Invalid token',
        code: 'invalid_token',
        requestId,
      },
      401
    );
  }

  if (error instanceof ProxyHttpError) {
    return c.json(
      {
        error: error.expose ? error.message : 'Internal server error',
        code: error.code,
        requestId,
      },
      error.status as never
    );
  }

  console.error(`[credential-proxy] unexpected error requestId=${requestId}`, error);

  return c.json(
    {
      error: 'Internal server error',
      code: 'internal_error',
      requestId,
    },
    500
  );
}

export default app;
