import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionClient, type ReplaySessionResult } from '@agent-relay/session';
import { Command, InvalidArgumentError } from 'commander';

import { defaultExit } from '../lib/exit.js';
import { resolveWorkspaceSessionKey } from '../lib/workspace-session.js';

/** The durable reference is Relay's ai-hist session UUID, never a local alias. */
const SESSION_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_RELAYHISTORY_HOST = 'history.agentrelay.com';
/** Same fallback chain `@agent-relay/session`'s `SessionClient` resolves a token from. */
const RELAYHISTORY_TOKEN_ENV_VARS = ['RELAYHISTORY_TOKEN', 'RELAYHISTORY_ACCESS_TOKEN', 'RELAY_AGENT_TOKEN'];

export interface SessionReplayClient {
  replaySession(sessionId: string): Promise<ReplaySessionResult>;
}

export interface StoredRelayhistoryAuth {
  baseUrl?: string;
  token?: string;
}

export interface SessionCommandDependencies {
  createClient: (storedAuth: StoredRelayhistoryAuth | null) => SessionReplayClient;
  readStoredAuth: () => StoredRelayhistoryAuth | null;
  resolveWorkspaceKey: () => string | undefined;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never;
}

function readStoredRelayhistoryAuth(): StoredRelayhistoryAuth | null {
  try {
    const authDir =
      process.env.RELAYHISTORY_HOME ?? path.join(os.homedir(), '.agentworkforce', 'relayhistory');
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(authDir, 'auth.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const auth = parsed as Record<string, unknown>;
    const baseUrl = typeof auth.base_url === 'string' ? trustedStoredBaseUrl(auth.base_url) : undefined;
    const token =
      typeof auth.access_token === 'string' && auth.access_token.trim()
        ? auth.access_token.trim()
        : undefined;
    return baseUrl || token ? { baseUrl, token } : null;
  } catch {
    return null;
  }
}

/** Exported for direct unit coverage of the local-vs-production host allowlist. */
export function trustedStoredBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (
      (url.protocol === 'https:' && url.hostname === ALLOWED_RELAYHISTORY_HOST) ||
      (local && url.protocol === 'http:')
    ) {
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // A malformed local credential file is ignored; explicit environment config remains available.
  }
  return undefined;
}

function nonBlankEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Explicit `RELAYHISTORY_*`/`RELAY_AGENT_TOKEN` environment configuration
 * must win over whatever is cached in `auth.json` — otherwise a developer
 * pointing at a local Relayhistory instance can never override stored
 * production credentials. `SessionClient` itself prefers its constructor
 * options over its own env fallback, so the stored value can only be handed
 * to it when the corresponding environment variable is absent.
 */
/** Exported for direct unit coverage of the explicit-env-over-stored-auth precedence. */
export function resolveRelayhistoryConfig(storedAuth: StoredRelayhistoryAuth | null): {
  baseUrl: string | undefined;
  token: string | undefined;
} {
  return {
    baseUrl: nonBlankEnv('RELAYHISTORY_URL') ?? storedAuth?.baseUrl,
    token: nonBlankEnv(...RELAYHISTORY_TOKEN_ENV_VARS) ?? storedAuth?.token,
  };
}

/** Resolve the workspace-wide Relaycast replay credential independently of Relayhistory auth. */
export function resolveRelaycastConfig(persistedWorkspaceKey?: string): {
  baseUrl: string | undefined;
  workspaceKey: string | undefined;
} {
  return {
    baseUrl: nonBlankEnv('RELAY_BASE_URL'),
    workspaceKey:
      nonBlankEnv('RELAY_WORKSPACE_KEY', 'AGENT_RELAY_WORKSPACE_KEY') ??
      (persistedWorkspaceKey?.trim() || undefined),
  };
}

function withDefaults(overrides: Partial<SessionCommandDependencies> = {}): SessionCommandDependencies {
  const resolveWorkspaceKey = overrides.resolveWorkspaceKey ?? resolveWorkspaceSessionKey;
  return {
    createClient:
      overrides.createClient ??
      ((storedAuth) => {
        const config = resolveRelayhistoryConfig(storedAuth);
        const relaycast = resolveRelaycastConfig(resolveWorkspaceKey());
        return new SessionClient({
          baseUrl: config.baseUrl,
          token: config.token,
          relaycastBaseUrl: relaycast.baseUrl,
          workspaceKey: relaycast.workspaceKey,
        });
      }),
    readStoredAuth: overrides.readStoredAuth ?? readStoredRelayhistoryAuth,
    resolveWorkspaceKey,
    log: overrides.log ?? ((...args: unknown[]) => console.log(...args)),
    error: overrides.error ?? ((...args: unknown[]) => console.error(...args)),
    exit: overrides.exit ?? defaultExit,
  };
}

function parseSessionRef(value: string): string {
  const sessionRef = value.trim();
  if (!SESSION_REF_PATTERN.test(sessionRef)) {
    throw new InvalidArgumentError('Session id must be a Relay-emitted UUID.');
  }
  return sessionRef;
}

/** Register durable completed-session replay joined across Relayhistory and Relaycast. */
export function registerSessionCommands(
  program: Command,
  overrides: Partial<SessionCommandDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  const group = program.command('session').description('Read durable completed Relay sessions');

  group
    .command('replay')
    .description('Reconstruct a completed Relay session from Relayhistory and Relaycast')
    .argument('<id>', 'Relay-emitted session UUID', parseSessionRef)
    .action(async (sessionId: string) => {
      const storedAuth = deps.readStoredAuth();
      const config = resolveRelayhistoryConfig(storedAuth);
      if (!config.baseUrl) {
        deps.error(
          'No Relayhistory endpoint is configured. Set RELAYHISTORY_URL, or sign in so ' +
            '~/.agentworkforce/relayhistory/auth.json has a base_url.'
        );
        deps.exit(1);
        return;
      }
      if (!config.token) {
        deps.error(
          'No Relayhistory credential is configured. Set RELAYHISTORY_TOKEN ' +
            '(or RELAYHISTORY_ACCESS_TOKEN/RELAY_AGENT_TOKEN), or sign in so ' +
            '~/.agentworkforce/relayhistory/auth.json has an access_token.'
        );
        deps.exit(1);
        return;
      }
      const replay = await deps.createClient(storedAuth).replaySession(sessionId);
      deps.log(replay.contextPrompt);
    });
}
