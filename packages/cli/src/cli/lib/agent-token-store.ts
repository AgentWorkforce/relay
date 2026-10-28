import fs from 'node:fs';
import { pbkdf2Sync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { withFileLock, writeFileAtomically } from './locked-json-file.js';

/**
 * Agent tokens the CLI registered, saved by name so `--as <name>` works in
 * any shell without exporting RELAY_AGENT_TOKEN. Each token is filed under
 * the server origin and a one-way fingerprint of the workspace key it was
 * minted with, so a name in one workspace never resolves to another's token.
 */
export const AGENT_TOKENS_FILE = 'agent-tokens.json';

const HOSTED_DEFAULT_ORIGIN = 'https://cast.agentrelay.com';

interface AgentTokenFile {
  version: 1;
  tokens: Record<string, string>;
}

/**
 * Where saved agent tokens live: next to the workspace store, honouring the
 * process's AGENT_RELAY_HOME when a scoped env omits it.
 *
 * @param env - Environment to read AGENT_RELAY_HOME from.
 * @returns Absolute path of the token file.
 */
export function agentTokensPath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    env.AGENT_RELAY_HOME ?? process.env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
  return path.join(home, AGENT_TOKENS_FILE);
}

function entryKey(workspaceKey: string, baseUrl: string | undefined, name: string): string {
  const origin = baseUrl ? new URL(baseUrl).origin : HOSTED_DEFAULT_ORIGIN;
  // One-way and opaque: the key is high-entropy, so this only hides it.
  const workspace = pbkdf2Sync(
    workspaceKey.trim(),
    'agent-relay:agent-token-store',
    10_000,
    16,
    'sha256'
  ).toString('hex');
  return `${origin}|${workspace}|${name}`;
}

function readTokens(env: NodeJS.ProcessEnv): AgentTokenFile {
  let raw: string;
  try {
    raw = fs.readFileSync(agentTokensPath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tokens: {} };
    throw new Error(`Could not read ${agentTokensPath(env)}; fix or remove it.`, { cause: error });
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentTokenFile> | null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.version === 1 &&
      parsed.tokens &&
      typeof parsed.tokens === 'object' &&
      !Array.isArray(parsed.tokens) &&
      Object.values(parsed.tokens).every((token) => typeof token === 'string' && token.length > 0)
    ) {
      return { version: 1, tokens: { ...parsed.tokens } };
    }
  } catch {
    // Reported below.
  }
  throw new Error(`${agentTokensPath(env)} is not a valid agent token file; fix or remove it.`);
}

/**
 * Save the token `agent register`/`agent rotate` just received. The update
 * holds a cross-process lock so concurrent registrations never drop each
 * other's tokens.
 *
 * @param workspaceKey - The workspace key the token was minted with.
 * @param baseUrl - The server it was minted on, or `undefined` for hosted.
 * @param name - The agent name `--as` will use.
 * @param token - The agent token.
 * @param env - Environment used to locate the token file.
 */
export function saveAgentToken(
  workspaceKey: string,
  baseUrl: string | undefined,
  name: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const file = agentTokensPath(env);
  const key = entryKey(workspaceKey, baseUrl, name);
  withFileLock(file, () => {
    const store = readTokens(env);
    store.tokens[key] = token;
    writeFileAtomically(file, `${JSON.stringify(store, null, 2)}\n`);
  });
}

/**
 * The saved token for `name` in this workspace on this server, if any.
 *
 * @param workspaceKey - The workspace key in use.
 * @param baseUrl - The server in use, or `undefined` for hosted.
 * @param name - The agent name passed to `--as`.
 * @param env - Environment used to locate the token file.
 * @returns The saved token, or `undefined`.
 */
export function savedAgentToken(
  workspaceKey: string,
  baseUrl: string | undefined,
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return readTokens(env).tokens[entryKey(workspaceKey, baseUrl, name)];
}
