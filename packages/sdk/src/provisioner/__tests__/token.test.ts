import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalJwksKeyPair } from '../local-jwks.js';
import { DEFAULT_WORKFLOW_TOKEN_TTL_SECONDS, mintAgentToken, type TokenClaims } from '../token.js';

function decodeJwtPayload(token: string): TokenClaims {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
}

function testSigningKey() {
  const { privateKey, kid } = createLocalJwksKeyPair();
  return { privateKey, kid };
}

test('mintAgentToken returns a valid JWT', () => {
  const token = mintAgentToken({
    ...testSigningKey(),
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: ['relayfile:fs:read:/src/index.ts'],
  });

  const parts = token.split('.');
  assert.equal(parts.length, 3);
  assert.ok(parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part)));
});

test('mintAgentToken payload contains agent_name, workspace, and scopes', () => {
  const scopes = ['relayfile:fs:read:/src/index.ts', 'relayfile:fs:write:/src/index.ts'];
  const token = mintAgentToken({
    ...testSigningKey(),
    agentName: 'compiler',
    workspace: 'workspace-abc',
    scopes,
  });

  const payload = decodeJwtPayload(token);

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

  const payload = decodeJwtPayload(token);

  assert.equal(payload.exp - payload.iat, DEFAULT_WORKFLOW_TOKEN_TTL_SECONDS);
  assert.equal(payload.exp - payload.iat, 2 * 60 * 60);
});
