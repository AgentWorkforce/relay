export type ProviderType = 'openai' | 'anthropic' | 'openrouter';

export interface ProxyTokenClaims {
  sub: string;
  aud: 'relay-llm-proxy';
  provider: ProviderType;
  credentialId: string;
  budget?: number;
  iat?: number;
  exp?: number;
  jti?: string;
  iss?: string;
}

export interface AdminTokenClaims {
  sub: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  iss?: string;
  role?: string;
  permissions?: string[];
  scope?: string | string[];
}

export interface ProxyRequest {
  provider: ProviderType;
  credentialId: string;
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ProxyResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface MeteringRecord {
  requestId: string;
  workspaceId: string;
  provider: ProviderType;
  credentialId: string;
  endpoint: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: string;
  durationMs: number;
}
