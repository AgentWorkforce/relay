import os from 'node:os';
import path from 'node:path';

export type StoredAuth = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  apiUrl: string;
};

export type WhoAmIResponse = {
  authenticated: boolean;
  source: 'session' | 'token';
  subjectType: string | null;
  scopes: string[];
  user: {
    id: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
  };
  currentOrganization: {
    id: string;
    slug: string;
    name: string;
    role: string;
    status: string;
  };
  currentWorkspace: {
    id: string;
    organization_id: string;
    slug: string;
    name: string;
  };
};

export type AuthSessionResponse = {
  sessionId: string;
  ssh: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  remoteCommand: string;
  provider: string;
  expiresAt: string;
};

export type WorkflowFileType = 'yaml' | 'ts' | 'py';

export type PathSubmission = {
  name: string;
  s3CodeKey: string;
  repoOwner?: string;
  repoName?: string;
  pushBranch?: string;
  pushBase?: string;
  pushPrBody?: string;
};

export type RunWorkflowOptions = {
  apiUrl?: string;
  fileType?: WorkflowFileType;
  syncCode?: boolean;
};

export type RunWorkflowResponse = {
  runId: string;
  sandboxId?: string;
  status: string;
  patches?: Record<
    string,
    {
      s3Key: string;
      hasChanges?: boolean;
      pushedTo?: {
        branch: string;
        prUrl: string;
        sha: string;
        base: { branch: string; sha: string };
        strategy?: 'contents_api' | 'git_db';
      };
      pushError?: {
        code: string;
        message: string;
        observedBaseSha?: string;
        base?: { branch: string; sha: string };
      };
    }
  >;
  [key: string]: unknown;
};

export type WorkflowLogsResponse = {
  content: string;
  offset: number;
  totalSize: number;
  done: boolean;
  [key: string]: unknown;
};

export type SyncPatchResponse = {
  patch: string;
  hasChanges: boolean;
  patches?: Record<string, { patch: string; hasChanges: boolean }>;
  [key: string]: unknown;
};

export type GetPatchesResponse = {
  patches: Record<string, { patch: string; hasChanges: boolean }>;
};

export const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'cursor', 'opencode', 'droid'] as const;

export const REFRESH_WINDOW_MS = 60_000;
export const AUTH_FILE_PATH = path.join(os.homedir(), '.agent-relay', 'cloud-auth.json');

export function defaultApiUrl(): string {
  return process.env.CLOUD_API_URL?.trim() || 'https://agentrelay.com/cloud';
}

export function isSupportedProvider(provider: string): boolean {
  return SUPPORTED_PROVIDERS.includes(provider as (typeof SUPPORTED_PROVIDERS)[number]);
}
