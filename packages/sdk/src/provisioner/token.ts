import { randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';

export const DEFAULT_WORKFLOW_TOKEN_TTL_SECONDS = 2 * 60 * 60;
export const DEFAULT_ADMIN_AGENT_NAME = 'relay-admin';
export const DEFAULT_ADMIN_SCOPES = [
  'relayauth:*:manage:*',
  'relayauth:*:read:*',
  'relayfile:*:*:*',
  'fs:read',
  'fs:write',
  'sync:trigger',
  'ops:read',
  'admin:read',
];

export interface TokenClaims {
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

export interface MintAgentTokenOptions {
  privateKey: KeyObject;
  kid: string;
  agentName: string;
  workspace: string;
  scopes: string[];
  ttlSeconds?: number;
}

function base64urlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function normalizeTtlSeconds(ttlSeconds?: number): number {
  if (ttlSeconds === undefined) {
    return DEFAULT_WORKFLOW_TOKEN_TTL_SECONDS;
  }

  return Math.max(1, Math.floor(ttlSeconds));
}

export function mintAgentToken(opts: MintAgentTokenOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: opts.kid } as const;
  const payload: TokenClaims = {
    sub: `agent_${opts.agentName}`,
    org: 'org_relay',
    wks: opts.workspace,
    workspace_id: opts.workspace,
    agent_name: opts.agentName,
    scopes: [...opts.scopes],
    sponsorId: 'relay-local',
    sponsorChain: ['relay-local'],
    token_type: 'access',
    iss: 'relayauth:local',
    aud: ['relayauth', 'relayfile'],
    iat: now,
    exp: now + normalizeTtlSeconds(opts.ttlSeconds),
    jti: `tok-${now}-${randomUUID()}`,
  };

  const unsigned = `${base64urlEncode(header)}.${base64urlEncode(payload)}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(unsigned), opts.privateKey).toString('base64url');

  return `${unsigned}.${signature}`;
}

export class WorkflowTokenFactory {
  private readonly tokens = new Map<string, string>();
  private readonly ttlSeconds: number;

  constructor(
    private readonly privateKey: KeyObject,
    private readonly kid: string,
    private readonly workspace: string,
    ttlSeconds = DEFAULT_WORKFLOW_TOKEN_TTL_SECONDS
  ) {
    this.ttlSeconds = normalizeTtlSeconds(ttlSeconds);
  }

  mintForAgent(agentName: string, scopes: string[], ttlSeconds = this.ttlSeconds): string {
    const token = mintAgentToken({
      privateKey: this.privateKey,
      kid: this.kid,
      workspace: this.workspace,
      agentName,
      scopes,
      ttlSeconds,
    });

    this.tokens.set(agentName, token);
    return token;
  }

  mintAdmin(ttlSeconds = this.ttlSeconds): string {
    return this.mintForAgent(DEFAULT_ADMIN_AGENT_NAME, DEFAULT_ADMIN_SCOPES, ttlSeconds);
  }

  getToken(agentName: string): string | undefined {
    return this.tokens.get(agentName);
  }
}
