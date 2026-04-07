import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

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

test('mintAgentToken returns a valid JWT', () => {
  const token = mintAgentToken({
    secret: 'test-secret',
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: ['relayfile:fs:read:/src/index.ts'],
  });

  const parts = token.split('.');
  const decoded = decodeJwt(token);

  assert.equal(parts.length, 3);
  assert.ok(parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part)));
  assert.deepEqual(decoded.header, { alg: 'HS256', typ: 'JWT' });
  assert.equal(decoded.payload.sub, 'agent_worker');
});

test('mintAgentToken payload contains agent_name, workspace, and scopes', () => {
  const scopes = ['relayfile:fs:read:/src/index.ts', 'relayfile:fs:write:/src/index.ts'];
  const token = mintAgentToken({
    secret: 'test-secret',
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
    secret: 'test-secret',
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
    secret: 'test-secret',
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: [],
    ttlSeconds: 90,
  });

  const { payload } = decodeJwt(token);

  assert.equal(payload.exp - payload.iat, 90);
});

test('WorkflowTokenFactory mintAdmin uses the default admin identity and scopes', () => {
  const factory = new WorkflowTokenFactory('test-secret', 'workspace-admin');
  const token = factory.mintAdmin();
  const { payload } = decodeJwt(token);

  assert.equal(payload.agent_name, DEFAULT_ADMIN_AGENT_NAME);
  assert.equal(payload.wks, 'workspace-admin');
  assert.deepEqual(payload.scopes, DEFAULT_ADMIN_SCOPES);
});

test('WorkflowTokenFactory getToken returns the token minted for an agent', () => {
  const factory = new WorkflowTokenFactory('test-secret', 'workspace-123');
  const token = factory.mintForAgent('builder', ['relayfile:fs:read:/src/index.ts']);

  assert.equal(factory.getToken('builder'), token);
});

test('WorkflowTokenFactory uses its configured TTL when minting agent tokens', () => {
  const factory = new WorkflowTokenFactory('test-secret', 'workspace-123', 45);
  const token = factory.mintForAgent('builder', []);
  const { payload } = decodeJwt(token);

  assert.equal(payload.exp - payload.iat, 45);
});

test('mintAgentToken generates a unique JTI per token', () => {
  const first = decodeJwt(
    mintAgentToken({
      secret: 'test-secret',
      agentName: 'worker',
      workspace: 'workspace-123',
      scopes: [],
    })
  ).payload;
  const second = decodeJwt(
    mintAgentToken({
      secret: 'test-secret',
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
    secret: 'test-secret',
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: [],
  });

  const { payload } = decodeJwt(token);

  assert.deepEqual(payload.aud, ['relayauth', 'relayfile']);
});

test('mintAgentToken signs tokens with HMAC-SHA256', () => {
  const secret = 'test-secret';
  const token = mintAgentToken({
    secret,
    agentName: 'worker',
    workspace: 'workspace-123',
    scopes: ['relayfile:fs:read:/src/index.ts'],
  });

  const [header, payload, signature] = token.split('.');
  const expectedSignature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');

  assert.equal(signature, expectedSignature);
});
