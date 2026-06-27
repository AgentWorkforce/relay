import fs from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { Command } from 'commander';

interface ReflexState {
  enabled: boolean;
  enabledAt?: string;
}

export type LoginCloudResult = { ok: true } | { ok: false; error: string };

export interface ReflexDependencies {
  fs: typeof fs;
  homedir: () => string;
  readRelayAuth: () => Promise<{ accessToken: string } | null>;
  loginToCloud: (relayAccessToken: string) => Promise<LoginCloudResult>;
  prompt: (question: string) => Promise<boolean>;
  log: (...args: unknown[]) => void;
}

const ALLOWED_RELAYHISTORY_HOSTS = new Set(['history.agentrelay.com']);

function validateRelayhistoryBaseUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `AI_HIST_BASE_URL is not a valid URL: ${raw}` };
  }
  const isLocalDev =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (!isLocalDev && !ALLOWED_RELAYHISTORY_HOSTS.has(parsed.hostname)) {
    return {
      ok: false,
      error: `AI_HIST_BASE_URL hostname "${parsed.hostname}" is not an allowed relayhistory host`,
    };
  }
  return { ok: true, url: parsed };
}

function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(false);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

async function defaultReadRelayAuth(): Promise<{ accessToken: string } | null> {
  const { readStoredAuth } = await import('@agent-relay/cloud');
  return readStoredAuth();
}

async function defaultLoginToCloud(relayAccessToken: string): Promise<LoginCloudResult> {
  const rawBase = process.env.AI_HIST_BASE_URL ?? 'https://history.agentrelay.com';
  const validated = validateRelayhistoryBaseUrl(rawBase);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const url = `${rawBase.replace(/\/$/, '')}/v1/cli/login`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentRelayToken: relayAccessToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, error: `Login failed (HTTP ${resp.status}): ${text.slice(0, 200)}` };
  }

  let payload: Record<string, unknown>;
  try {
    const raw: unknown = await resp.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'Login response has unexpected shape' };
    }
    payload = raw as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Login response was not valid JSON' };
  }

  if (typeof payload.accessToken !== 'string') {
    return { ok: false, error: 'Login response missing accessToken' };
  }

  // Persist rth_at_ tokens so ai-hist sync/push can authenticate on subsequent runs.
  try {
    const configDir = process.env.AI_HIST_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'ai-hist');
    const authPath = path.join(configDir, 'auth.json');
    const auth = {
      baseUrl: rawBase.replace(/\/$/, ''),
      accessToken: payload.accessToken,
      ...(typeof payload.refreshToken === 'string' ? { refreshToken: payload.refreshToken } : {}),
    };
    await mkdir(configDir, { recursive: true });
    await writeFile(authPath, JSON.stringify(auth, null, 2));
    // Explicitly tighten perms — writeFile mode only applies to newly created files.
    await chmod(authPath, 0o600);
  } catch {
    // Non-fatal: local state is written; cloud sync may prompt again next run.
  }

  return { ok: true };
}

function withDefaults(overrides: Partial<ReflexDependencies> = {}): ReflexDependencies {
  return {
    fs,
    homedir: os.homedir,
    readRelayAuth: defaultReadRelayAuth,
    loginToCloud: defaultLoginToCloud,
    prompt: promptYesNo,
    log: (...args: unknown[]) => console.log(...args),
    ...overrides,
  };
}

function getReflexDir(deps: ReflexDependencies): string {
  return path.join(deps.homedir(), '.agentworkforce');
}

function getReflexStateFile(deps: ReflexDependencies): string {
  return path.join(getReflexDir(deps), 'reflex.json');
}

function writeReflexState(deps: ReflexDependencies, state: ReflexState): void {
  deps.fs.mkdirSync(getReflexDir(deps), { recursive: true });
  deps.fs.writeFileSync(getReflexStateFile(deps), JSON.stringify(state, null, 2), 'utf-8');
}

function readReflexState(deps: ReflexDependencies): ReflexState | null {
  const stateFile = getReflexStateFile(deps);
  if (!deps.fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(deps.fs.readFileSync(stateFile, 'utf-8')) as ReflexState;
  } catch {
    return null;
  }
}

export function registerReflexCommands(program: Command, overrides: Partial<ReflexDependencies> = {}): void {
  const deps = withDefaults(overrides);
  const reflex = program.command('reflex').description('Manage Reflex history sync');

  reflex
    .command('on')
    .description('Enable Reflex history sync')
    .action(async () => {
      deps.log('Reflex will capture your agent sessions and sync to history.agentrelay.com');

      const accepted = await deps.prompt('Enable Reflex? (y/N) ');
      if (!accepted) {
        deps.log('Reflex was not enabled.');
        return;
      }

      writeReflexState(deps, {
        enabled: true,
        enabledAt: new Date().toISOString(),
      });

      const relayAuth = await deps.readRelayAuth();
      if (!relayAuth) {
        deps.log(
          'Not logged in to Agent Relay. Run `agent-relay login` first to sync Reflex history to the cloud.'
        );
      } else {
        const result = await deps.loginToCloud(relayAuth.accessToken);
        if (!result.ok) {
          deps.log(`Reflex is enabled locally, but cloud login did not complete: ${result.error}`);
        }
      }

      deps.log('Reflex is on.');
      deps.log('State file: ~/.agentworkforce/reflex.json');
    });

  reflex
    .command('off')
    .description('Disable Reflex history sync')
    .action(() => {
      writeReflexState(deps, { enabled: false });
      deps.log('Reflex is off.');
    });

  reflex
    .command('status')
    .description('Show Reflex status')
    .action(() => {
      const state = readReflexState(deps);
      if (!state) {
        deps.log('Reflex is off (never enabled).');
        return;
      }

      if (state.enabled) {
        deps.log('Reflex is on.');
        if (state.enabledAt) {
          deps.log(`Enabled at: ${state.enabledAt}`);
        }
        return;
      }

      deps.log('Reflex is off.');
      if (state.enabledAt) {
        deps.log(`Enabled at: ${state.enabledAt}`);
      }
    });
}
