/**
 * Daytona local credential capture.
 *
 * Daytona's `login` is an Auth0 (daytonaio.us.auth0.com) browser OAuth flow that
 * binds a loopback callback server (http://localhost:<port>/callback) and has NO
 * device-code fallback. That callback cannot be delivered into a remote sandbox:
 * Daytona's managed SSH gateway (ssh.app.daytona.io) does not forward TCP
 * (direct-tcpip) into the sandbox, so the in-sandbox capture path other providers
 * use (run the CLI over interactive SSH, cloud reads the credential file) hangs at
 * the callback. See cloud `sandbox-auth.ts` for the gateway limitation.
 *
 * So we capture daytona LOCALLY: run `daytona login` on the user's own machine
 * (browser + loopback both local — works natively), read the CLI's token store,
 * normalize it to the stored contract, and upload it to the cloud credential store
 * via an authenticated endpoint. Everything downstream (refresh, status, deploy
 * gating) is identical to the sandbox-captured providers — only the transport
 * differs.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureAuthenticated, authorizedApiFetch } from './auth.js';
import { defaultApiUrl } from './types.js';

/** The normalized credential contract stored under provider 'daytona'. */
export interface DaytonaCredential {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 (RFC3339) expiry, exactly as the daytona CLI writes it. */
  expiresAt: string;
  /** Active organization id; omitted when the profile has none. */
  orgId?: string;
}

/** Subset of the daytona CLI's config.json we read (unknown fields ignored). */
interface DaytonaStoredToken {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}
interface DaytonaProfile {
  id?: string;
  api?: { token?: DaytonaStoredToken | null } | null;
  activeOrganizationId?: string | null;
}
interface DaytonaConfig {
  activeProfile?: string;
  profiles?: DaytonaProfile[];
}

/** Cloud route that accepts the already-normalized daytona credential. */
export const DAYTONA_CREDENTIAL_UPLOAD_PATH = '/api/v1/cli/auth/daytona/credential';

/**
 * Resolve the daytona CLI's config.json path, mirroring the Go CLI's
 * `os.UserConfigDir()` plus the `DAYTONA_CONFIG_DIR` override it honors.
 */
export function daytonaConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir
): string {
  const override = env.DAYTONA_CONFIG_DIR;
  if (override) return path.join(override, 'config.json');
  switch (platform) {
    case 'darwin':
      return path.join(homedir(), 'Library', 'Application Support', 'daytona', 'config.json');
    case 'win32':
      return path.join(env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'daytona', 'config.json');
    default:
      return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'daytona', 'config.json');
  }
}

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Pick the active profile (by `activeProfile` id), falling back to the first. */
function selectActiveProfile(config: DaytonaConfig): DaytonaProfile {
  const profiles = config.profiles ?? [];
  if (profiles.length === 0) {
    throw new Error('No Daytona profiles found in config.json. Run `daytona login` to authenticate.');
  }
  if (config.activeProfile) {
    const byActive = profiles.find((p) => p.id === config.activeProfile);
    if (!byActive) {
      throw new Error(
        `Daytona config references activeProfile "${config.activeProfile}", but that profile was not found. ` +
          'Run `daytona login` to refresh the profile list.'
      );
    }
    return byActive;
  }
  return profiles[0];
}

function validateExpiresAt(expiresAt: string): void {
  if (!RFC3339_TIMESTAMP.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('Daytona profile has invalid `expiresAt`; expected an RFC3339 timestamp.');
  }
}

/**
 * Extract + normalize the daytona credential from a parsed config.json into the
 * stored contract. Throws a clear error if the token is missing/incomplete.
 */
export function extractDaytonaCredential(config: DaytonaConfig): DaytonaCredential {
  const profile = selectActiveProfile(config);
  const token = profile.api?.token;
  if (!token?.accessToken || !token.refreshToken || !token.expiresAt) {
    throw new Error(
      'Daytona profile has no complete OAuth token (accessToken/refreshToken/expiresAt). ' +
        'Run `daytona login` (browser) — an api-key login does not yield a refresh token.'
    );
  }
  validateExpiresAt(token.expiresAt);
  const credential: DaytonaCredential = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
  };
  const orgId = profile.activeOrganizationId;
  if (typeof orgId === 'string' && orgId.length > 0) {
    credential.orgId = orgId;
  }
  return credential;
}

/** Read + parse the daytona config.json and extract the normalized credential. */
export async function readDaytonaCredential(
  configPath: string,
  read: (p: string) => Promise<string> = (p) => readFile(p, 'utf8')
): Promise<DaytonaCredential> {
  let raw: string;
  try {
    raw = await read(configPath);
  } catch {
    throw new Error(
      `Could not read Daytona config at ${configPath}. ` + 'Run `daytona login` to authenticate first.'
    );
  }
  let config: DaytonaConfig;
  try {
    config = JSON.parse(raw) as DaytonaConfig;
  } catch {
    throw new Error(`Daytona config at ${configPath} is not valid JSON.`);
  }
  return extractDaytonaCredential(config);
}

export interface ConnectDaytonaIo {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Injection seams — defaulted in production, overridden in tests. */
export interface DaytonaLocalRuntime {
  /** Whether the `daytona` CLI is on PATH. */
  hasDaytonaCli: () => Promise<boolean>;
  /** Run `daytona login` interactively (inherits the terminal). Resolves with exit code. */
  runLogin: () => Promise<number>;
  /** Read the daytona config.json. */
  readConfig: (configPath: string) => Promise<string>;
  /** Resolve the config.json path. */
  configPath: () => string;
  /** Upload the normalized credential to the cloud store. Returns false on failure. */
  upload: (credential: DaytonaCredential, apiUrl: string) => Promise<boolean>;
}

function spawnExitCode(command: string, args: string[], inherit: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: inherit ? 'inherit' : 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function defaultRuntime(apiUrlOverride?: string): DaytonaLocalRuntime {
  return {
    hasDaytonaCli: async () => {
      try {
        // `daytona version` exits 0 when installed; ENOENT rejects when absent.
        const code = await spawnExitCode('daytona', ['version'], false);
        return code === 0;
      } catch {
        return false;
      }
    },
    runLogin: () => spawnExitCode('daytona', ['login'], true),
    readConfig: (p) => readFile(p, 'utf8'),
    configPath: () => daytonaConfigPath(),
    upload: async (credential, apiUrl) => {
      const auth = await ensureAuthenticated(apiUrl);
      const { response } = await authorizedApiFetch(auth, DAYTONA_CREDENTIAL_UPLOAD_PATH, {
        method: 'POST',
        body: JSON.stringify(credential),
      });
      if (!response.ok) {
        // Surface the cloud error (400 validation / 401-403 auth / 502 store)
        // so the user sees why capture failed rather than a generic message.
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Credential upload failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`
        );
      }
      return true;
    },
  };
}

export interface ConnectDaytonaLocalOptions {
  apiUrl?: string;
  io?: ConnectDaytonaIo;
  runtime?: Partial<DaytonaLocalRuntime>;
}

export interface ConnectDaytonaLocalResult {
  provider: 'daytona';
  success: boolean;
}

const color = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/**
 * Capture daytona credentials locally and upload them to the cloud store.
 *
 * Flow: ensure the daytona CLI is present → run `daytona login` (browser) →
 * read the local config.json → normalize → upload. Throws on any failure.
 */
export async function connectDaytonaLocal(
  options: ConnectDaytonaLocalOptions = {}
): Promise<ConnectDaytonaLocalResult> {
  const io = options.io ?? {
    log: (...a: unknown[]) => console.log(...a),
    error: (...a: unknown[]) => console.error(...a),
  };
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const rt = { ...defaultRuntime(apiUrl), ...options.runtime };

  io.log('');
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log(color.cyan('      Daytona Authentication (local capture)'));
  io.log(color.cyan('═══════════════════════════════════════════════════'));
  io.log('');

  if (!(await rt.hasDaytonaCli())) {
    io.error(color.yellow('The Daytona CLI ("daytona") is not installed.'));
    io.log('Install it, then re-run this command:');
    io.log(color.dim('  brew install daytonaio/cli/daytona'));
    throw new Error('Daytona CLI not found on PATH.');
  }

  io.log('Opening Daytona login in your browser...');
  io.log(color.dim('(complete the login; the OAuth callback is handled locally)'));
  io.log('');
  const code = await rt.runLogin();
  if (code !== 0) {
    throw new Error(`\`daytona login\` exited with code ${code}.`);
  }

  io.log('');
  io.log('Reading Daytona credentials...');
  const credential = await readDaytonaCredential(rt.configPath(), rt.readConfig);

  io.log('Uploading credentials to cloud (encrypted at rest)...');
  const ok = await rt.upload(credential, apiUrl);
  if (!ok) {
    throw new Error('Failed to store Daytona credentials with cloud.');
  }

  io.log('');
  io.log(color.green('═══════════════════════════════════════════════════'));
  io.log(color.green('          Authentication Complete!'));
  io.log(color.green('═══════════════════════════════════════════════════'));
  io.log('');
  io.log('Daytona credentials are now stored and encrypted.');
  io.log(color.dim('They will be auto-refreshed; no further login needed.'));
  io.log('');

  return { provider: 'daytona', success: true };
}
