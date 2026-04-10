import { SignJWT, errors, jwtVerify } from 'jose';

import type { ProxyTokenClaims, ProviderType } from './types.js';

export type { ProxyTokenClaims } from './types.js';

export const PROXY_TOKEN_AUDIENCE = 'relay-llm-proxy';
export const DEFAULT_PROXY_TOKEN_TTL_SECONDS = 15 * 60;

const encoder = new TextEncoder();

export class TokenInvalidError extends Error {
  readonly cause?: unknown;

  constructor(message = 'Invalid proxy token', options?: { cause?: unknown }) {
    super(message);
    this.name = 'TokenInvalidError';
    this.cause = options?.cause;
  }
}

export class TokenExpiredError extends Error {
  readonly cause?: unknown;

  constructor(message = 'Proxy token expired', options?: { cause?: unknown }) {
    super(message);
    this.name = 'TokenExpiredError';
    this.cause = options?.cause;
  }
}

function getSecretKey(secret: string): Uint8Array {
  return encoder.encode(secret);
}

function isProviderType(value: unknown): value is ProviderType {
  return value === 'openai' || value === 'anthropic' || value === 'openrouter';
}

function normalizeAudience(value: unknown): typeof PROXY_TOKEN_AUDIENCE {
  if (value === PROXY_TOKEN_AUDIENCE) {
    return PROXY_TOKEN_AUDIENCE;
  }

  if (Array.isArray(value) && value.includes(PROXY_TOKEN_AUDIENCE)) {
    return PROXY_TOKEN_AUDIENCE;
  }

  throw new TokenInvalidError('Invalid proxy token audience');
}

function normalizeClaims(payload: Record<string, unknown>): ProxyTokenClaims {
  const { sub, aud, provider, credentialId, budget, exp } = payload;

  if (typeof sub !== 'string' || sub.length === 0) {
    throw new TokenInvalidError('Invalid proxy token subject');
  }

  if (!isProviderType(provider)) {
    throw new TokenInvalidError('Invalid proxy token provider');
  }

  if (typeof credentialId !== 'string' || credentialId.length === 0) {
    throw new TokenInvalidError('Invalid proxy token credentialId');
  }

  if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0)) {
    throw new TokenInvalidError('Invalid proxy token budget');
  }

  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new TokenInvalidError('Invalid proxy token expiration');
  }

  const normalizedBudget = typeof budget === 'number' ? budget : undefined;

  return {
    sub,
    aud: normalizeAudience(aud),
    provider,
    credentialId,
    budget: normalizedBudget,
    exp: Math.floor(exp),
  };
}

function resolveExpirationTime(exp?: number): number {
  if (typeof exp === 'number' && Number.isFinite(exp)) {
    return Math.floor(exp);
  }

  return Math.floor(Date.now() / 1000) + DEFAULT_PROXY_TOKEN_TTL_SECONDS;
}

export async function mintProxyToken(claims: ProxyTokenClaims, secret: string): Promise<string> {
  const expirationTime = resolveExpirationTime(claims.exp);

  return new SignJWT({
    provider: claims.provider,
    credentialId: claims.credentialId,
    ...(claims.budget === undefined ? {} : { budget: claims.budget }),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .sign(getSecretKey(secret));
}

export async function verifyProxyToken(token: string, secret: string): Promise<ProxyTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(secret), {
      algorithms: ['HS256'],
      audience: PROXY_TOKEN_AUDIENCE,
    });

    return normalizeClaims(payload as Record<string, unknown>);
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new TokenExpiredError('Proxy token expired', { cause: error });
    }

    if (error instanceof TokenInvalidError) {
      throw error;
    }

    throw new TokenInvalidError('Proxy token is invalid', { cause: error });
  }
}
