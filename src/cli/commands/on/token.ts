import { randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';

interface TokenClaims {
  sub: string;
  org: string;
  wks: string;
  workspace_id: string;
  agent_name: string;
  scopes: string[];
  sponsorId: string;
  sponsorChain: string[];
  token_type: string;
  iss: string;
  aud: string[];
  iat: number;
  exp: number;
  jti: string;
}

export function mintToken(opts: {
  privateKey: KeyObject;
  kid: string;
  agentName: string;
  workspace: string;
  scopes: string[];
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: opts.kid };
  const payload: TokenClaims = {
    sub: 'agent_' + opts.agentName,
    org: 'org_relay',
    wks: opts.workspace,
    workspace_id: opts.workspace,
    agent_name: opts.agentName,
    scopes: opts.scopes,
    sponsorId: 'relay-local',
    sponsorChain: ['relay-local'],
    token_type: 'access',
    iss: 'relayauth:local',
    aud: ['relayauth', 'relayfile'],
    iat: now,
    exp: now + (opts.ttlSeconds ?? 3600),
    jti: 'tok-' + now + '-' + randomUUID(),
  };

  const base64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');

  const unsigned = base64url(header) + '.' + base64url(payload);
  const signature = cryptoSign('RSA-SHA256', Buffer.from(unsigned), opts.privateKey).toString('base64url');

  return `${unsigned}.${signature}`;
}
