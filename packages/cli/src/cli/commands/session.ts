import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionClient, type ReplaySessionResult } from '@agent-relay/session';
import { Command, InvalidArgumentError } from 'commander';

/** The durable reference is Relay's ai-hist session UUID, never a local alias. */
const SESSION_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_RELAYHISTORY_HOST = 'history.agentrelay.com';

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
  log: (...args: unknown[]) => void;
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

function trustedStoredBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
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

function withDefaults(overrides: Partial<SessionCommandDependencies> = {}): SessionCommandDependencies {
  return {
    createClient: (storedAuth) =>
      new SessionClient({ baseUrl: storedAuth?.baseUrl, token: storedAuth?.token }),
    readStoredAuth: readStoredRelayhistoryAuth,
    log: (...args: unknown[]) => console.log(...args),
    ...overrides,
  };
}

function parseSessionRef(value: string): string {
  const sessionRef = value.trim();
  if (!SESSION_REF_PATTERN.test(sessionRef)) {
    throw new InvalidArgumentError('Session id must be a Relay-emitted UUID.');
  }
  return sessionRef;
}

/** Register durable completed-session replay backed by Relayhistory's existing journal. */
export function registerSessionCommands(
  program: Command,
  overrides: Partial<SessionCommandDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  const group = program.command('session').description('Read durable Relayhistory sessions');

  group
    .command('replay')
    .description('Reconstruct a completed Relay session as attributed Relayhistory context')
    .argument('<id>', 'Relay-emitted session UUID', parseSessionRef)
    .action(async (sessionId: string) => {
      const replay = await deps.createClient(deps.readStoredAuth()).replaySession(sessionId);
      deps.log(replay.contextPrompt);
    });
}
