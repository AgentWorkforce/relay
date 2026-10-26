import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

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

export function agentTokensPath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    env.AGENT_RELAY_HOME ?? process.env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
  return path.join(home, AGENT_TOKENS_FILE);
}

function entryKey(workspaceKey: string, baseUrl: string | undefined, name: string): string {
  const origin = baseUrl ? new URL(baseUrl).origin : HOSTED_DEFAULT_ORIGIN;
  const workspace = createHash('sha256').update(workspaceKey.trim()).digest('hex').slice(0, 32);
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
    const parsed = JSON.parse(raw) as Partial<AgentTokenFile>;
    if (parsed.version === 1 && parsed.tokens && typeof parsed.tokens === 'object') {
      return { version: 1, tokens: { ...parsed.tokens } };
    }
  } catch {
    // Reported below.
  }
  throw new Error(`${agentTokensPath(env)} is not a valid agent token file; fix or remove it.`);
}

/** Save the token `agent register`/`agent rotate` just received. */
export function saveAgentToken(
  workspaceKey: string,
  baseUrl: string | undefined,
  name: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const file = agentTokensPath(env);
  const store = readTokens(env);
  store.tokens[entryKey(workspaceKey, baseUrl, name)] = token;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** The saved token for `name` in this workspace on this server, if any. */
export function savedAgentToken(
  workspaceKey: string,
  baseUrl: string | undefined,
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return readTokens(env).tokens[entryKey(workspaceKey, baseUrl, name)];
}
