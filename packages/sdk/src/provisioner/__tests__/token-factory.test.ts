import assert from 'node:assert/strict';
import { createPublicKey, createVerify } from 'node:crypto';
import test from 'node:test';

import { createLocalJwksKeyPair } from '../local-jwks.js';
import {
  DEFAULT_ADMIN_AGENT_NAME,
  DEFAULT_ADMIN_SCOPES,
  DEFAULT_WORKFLOW_TOKEN_TTL_SECONDS,
  WorkflowTokenFactory,
  mintAgentToken,
  type TokenClaims,
} from '../token.js';

interface JwtHeader {
  alg: string;
  typ: string;
  kid: string;
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function decodeJwt(token: string): { header: JwtHeader; payload: TokenClaims; signature: string } {
  const [header, payload, signature] = token.split('.');
  assert.ok(header);
  assert.ok(payload);
  assert.ok(signature);

  return {
    header: decodeJwtPart<JwtHeader>(header),
    payload: decodeJwtPart<TokenClaims>(payload),
    signature,
  };
}

function testSigningKey() {
  const { privateKey, kid } = createLocalJwksKeyPair();
  return { privateKey, kid };
}

test('mintAgentToken returns a valid JWT', () => {
  const signingKey = testSigningKey();
  const token = mintAgentToken({
    ...signingKey,
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: ['relayfile:fs:read:/src/index.ts'],
  });

  const parts = token.split('.');
  const decoded = decodeJwt(token);

  assert.equal(parts.length, 3);
  assert.ok(parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part)));
  assert.deepEqual(decoded.header, { alg: 'RS256', typ: 'JWT', kid: signingKey.kid });
  assert.equal(decoded.payload.sub, 'agent_worker');
});

test('mintAgentToken payload contains agent_name, workspace, and scopes', () => {
  const signingKey = testSigningKey();
  const scopes = ['relayfile:fs:read:/src/index.ts', 'relayfile:fs:write:/src/index.ts'];
  const token = mintAgentToken({
    ...signingKey,
    agentName: 'compiler',
    workspace: 'workspace-abc',
    scopes,
  });

  const { payload } = decodeJwt(token);

  assert.equal(payload.agent_name, 'compiler');
  assert.equal(payload.wks, 'workspace-abc');
  assert.equal(payload.workspace_id, 'workspace-abc');
  assert.deepEqual(payload.scopes, scopes);
});

test('mintAgentToken defaults expiry to 2 hours', () => {
  const token = mintAgentToken({
    ...testSigningKey(),
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: [],
  });

  const { payload } = decodeJwt(token);

  assert.equal(payload.exp - payload.iat, DEFAULT_WORKFLOW_TOKEN_TTL_SECONDS);
  assert.equal(payload.exp - payload.iat, 2 * 60 * 60);
});

test('mintAgentToken applies a custom TTL', () => {
  const token = mintAgentToken({
    ...testSigningKey(),
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: [],
    ttlSeconds: 90,
  });

  const { payload } = decodeJwt(token);

  assert.equal(payload.exp - payload.iat, 90);
});

test('WorkflowTokenFactory mintAdmin uses the default admin identity and scopes', () => {
  const signingKey = testSigningKey();
  const factory = new WorkflowTokenFactory(signingKey.privateKey, signingKey.kid, 'workspace-admin');
  const token = factory.mintAdmin();
  const { payload } = decodeJwt(token);

  assert.equal(payload.agent_name, DEFAULT_ADMIN_AGENT_NAME);
  assert.equal(payload.wks, 'workspace-admin');
  assert.deepEqual(payload.scopes, DEFAULT_ADMIN_SCOPES);
});

test('WorkflowTokenFactory getToken returns the token minted for an agent', () => {
  const signingKey = testSigningKey();
  const factory = new WorkflowTokenFactory(signingKey.privateKey, signingKey.kid, 'workspace-123');
  const token = factory.mintForAgent('builder', ['relayfile:fs:read:/src/index.ts']);

  assert.equal(factory.getToken('builder'), token);
});

test('WorkflowTokenFactory uses its configured TTL when minting agent tokens', () => {
  const signingKey = testSigningKey();
  const factory = new WorkflowTokenFactory(signingKey.privateKey, signingKey.kid, 'workspace-123', 45);
  const token = factory.mintForAgent('builder', []);
  const { payload } = decodeJwt(token);

  assert.equal(payload.exp - payload.iat, 45);
});

test('mintAgentToken generates a unique JTI per token', () => {
  const first = decodeJwt(
    mintAgentToken({
      ...testSigningKey(),
      agentName: 'worker',
      workspace: 'workspace-123',
      scopes: [],
    })
  ).payload;
  const second = decodeJwt(
    mintAgentToken({
      ...testSigningKey(),
      agentName: 'worker',
      workspace: 'workspace-123',
      scopes: [],
    })
  ).payload;

  assert.notEqual(first.jti, second.jti);
  assert.match(first.jti, /^tok-\d+-/u);
  assert.match(second.jti, /^tok-\d+-/u);
});

test('mintAgentToken includes the expected audience claims', () => {
  const token = mintAgentToken({
    ...testSigningKey(),
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: [],
  });

  const { payload } = decodeJwt(token);

  assert.deepEqual(payload.aud, ['relayauth', 'relayfile']);
});

test('mintAgentToken signs tokens with RS256', () => {
  const signingKey = testSigningKey();
  const token = mintAgentToken({
    ...signingKey,
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: ['relayfile:fs:read:/src/index.ts'],
  });

  const [header, payload, signature] = token.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  verifier.end();

  assert.equal(verifier.verify(createPublicKey(signingKey.privateKey), signature, 'base64url'), true);
});
