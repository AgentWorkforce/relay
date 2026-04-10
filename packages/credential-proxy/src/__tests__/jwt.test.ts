import { decodeJwt, jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROXY_TOKEN_TTL_SECONDS,
  PROXY_TOKEN_AUDIENCE,
  TokenExpiredError,
  TokenInvalidError,
  mintProxyToken,
  verifyProxyToken,
} from '../jwt.js';
import type { ProxyTokenClaims } from '../types.js';

const secret = 'test-proxy-secret';
const secretKey = new TextEncoder().encode(secret);

function createClaims(overrides: Partial<ProxyTokenClaims> = {}): ProxyTokenClaims {
  return {
    sub: 'wks_123',
    aud: PROXY_TOKEN_AUDIENCE,
    provider: 'openai',
    credentialId: 'cred_123',
    ...overrides,
  };
}

describe('proxy JWT helpers', () => {
  it('minting produces a valid JWT', async () => {
    const token = await mintProxyToken(createClaims(), secret);
    const decoded = decodeJwt(token);
    const verified = await jwtVerify(token, secretKey, {
      algorithms: ['HS256'],
      audience: PROXY_TOKEN_AUDIENCE,
    });

    expect(token.split('.')).toHaveLength(3);
    expect(verified.payload.sub).toBe('wks_123');
    expect(verified.payload.credentialId).toBe('cred_123');
    expect(decoded.exp).toBeTypeOf('number');
    expect(decoded.iat).toBeTypeOf('number');
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(DEFAULT_PROXY_TOKEN_TTL_SECONDS);
  });

  it('verification succeeds for valid tokens', async () => {
    const claims = createClaims({
      provider: 'anthropic',
      credentialId: 'cred_valid',
      budget: 5000,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const token = await mintProxyToken(claims, secret);

    await expect(verifyProxyToken(token, secret)).resolves.toEqual({
      sub: claims.sub,
      aud: claims.aud,
      provider: claims.provider,
      credentialId: claims.credentialId,
      budget: claims.budget,
      exp: claims.exp,
    });
  });

  it('verification rejects expired tokens', async () => {
    const token = await mintProxyToken(
      createClaims({
        exp: Math.floor(Date.now() / 1000) - 60,
      }),
      secret
    );

    await expect(verifyProxyToken(token, secret)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('verification rejects wrong audience', async () => {
    const token = await new SignJWT({
      provider: 'openai',
      credentialId: 'cred_wrong_aud',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('wks_123')
      .setAudience('not-relay-llm-proxy')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(secretKey);

    await expect(verifyProxyToken(token, secret)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it('verification rejects tampered tokens', async () => {
    const token = await mintProxyToken(createClaims(), secret);
    const [header, payload, signature] = token.split('.');
    const tamperedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    const tamperedToken = `${header}.${payload}.${tamperedSignature}`;

    await expect(verifyProxyToken(tamperedToken, secret)).rejects.toBeInstanceOf(TokenInvalidError);
  });
});
