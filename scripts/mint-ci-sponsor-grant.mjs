#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

const issuer = 'https://auth.ci.agentrelay.test';
const audience = 'relayauth:sponsor-binding';
const sponsorId = 'user_ci_sponsor';
const orgId = 'org_ci';
const now = Math.floor(Date.now() / 1000);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const thumbprintInput = JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n });
const kid = createHash('sha256').update(thumbprintInput).digest('base64url');

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const header = encode({ alg: 'RS256', typ: 'JWT', kid });
const payload = encode({
  iss: issuer,
  aud: audience,
  sub: sponsorId,
  org: orgId,
  iat: now,
  // The test authority intentionally grants two hours: macOS release builds
  // can exceed 30 minutes before the broker smoke step reaches registration.
  exp: now + 60 * 60 * 2,
  jti: `spg_ci_${randomUUID().replaceAll('-', '')}`,
  intent: 'identity.create',
  token_type: 'sponsor_grant',
  oidc: {
    issuer: 'https://idp.ci.agentrelay.test',
    subject: 'oidc_ci_sponsor',
    iat: now,
  },
});
const signingInput = `${header}.${payload}`;
const signature = createSign('RSA-SHA256').update(signingInput).end().sign(privateKey, 'base64url');
const proof = `${signingInput}.${signature}`;

const output = process.env.GITHUB_ENV;
if (!output) {
  throw new Error('GITHUB_ENV is required; this signer is intentionally CI-only');
}

const write = (name, value) => {
  const delimiter = `EOF_${name}_${randomUUID().replaceAll('-', '')}`;
  appendFileSync(output, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, { mode: 0o600 });
};

write('RELAYAUTH_SPONSOR_ID', sponsorId);
write('RELAYAUTH_SPONSOR_ORG_ID', orgId);
write('RELAYAUTH_ISSUER', issuer);
write('RELAYAUTH_SIGNING_KEY_PEM_PUBLIC', publicKeyPem);
write('RELAYAUTH_SPONSOR_PROOF', proof);
write('RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_PUBLIC_KEY_PEM', publicKeyPem);
write('RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_ISSUER', issuer);
write('RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_AUDIENCE', audience);
