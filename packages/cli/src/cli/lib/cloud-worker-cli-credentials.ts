// Subscription-login materialisation for `agent-relay cloud worker`.
//
// A control plane that holds Codex/Grok subscription logins for the workspace
// (self-hosted relaycontrol; hosted Cloud mounts the same files in its own
// sandboxes) puts `cliCredentials` in the assignment payload: a short-lived,
// run-scoped reference, never the files. Before spawning relayflows, the worker
// exchanges the reference (with its worker token) for the auth files, writes
// each one 0600 into a 0700 directory inside the run's private dir, and points
// the CLI at it (CODEX_HOME / GROK_HOME). After the run it writes back a file
// the CLI refreshed, so the stored login keeps a live refresh token. The login
// directory is deleted after the run (even when the run dir is kept).
//
// Nothing here logs a file's content or the reference.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { CloudWorkerRecord } from '@agent-relay/cloud';

/** The `cliCredentials` field of an assignment payload. */
export type CliCredentialsPayload = {
  ref: string;
  expiresAt?: string;
  /** `/api/v1/workers/{workerId}/assignments/<runId>/cli-credentials`. */
  path: string;
  credentials?: Array<{ credentialId: string; provider: string; cli: string }>;
};

type CredentialFile = {
  credentialId: string;
  provider: string;
  cli: string;
  homeEnv: string;
  directory: string;
  file: string;
  content: string;
};

/** What was mounted for a run. */
export type MaterializedCliCredentials = {
  /** Env for the relayflows process (CODEX_HOME/GROK_HOME, AGENT_RELAY_SUBSCRIPTION_LOGINS). */
  env: Record<string, string>;
  /** The private directory holding every mounted login; delete it after the run. */
  home: string;
  files: Array<{ credentialId: string; cli: string; filePath: string; original: string }>;
};

/** Result of a write-back pass. */
export type CliCredentialWriteBack = { written: number; failed: Array<{ credentialId: string; cli: string }> };

/** The only layouts a login may use: each CLI's own home variable, directory and file. */
const CLI_LAYOUTS: Record<string, { homeEnv: string; directory: string; file: string }> = {
  codex: { homeEnv: 'CODEX_HOME', directory: '.codex', file: 'auth.json' },
  grok: { homeEnv: 'GROK_HOME', directory: '.grok', file: 'auth.json' },
};

/** Env flag relayflows reads to give the subscription precedence over API keys. */
export const SUBSCRIPTION_LOGINS_ENV = 'AGENT_RELAY_SUBSCRIPTION_LOGINS';

const CREDENTIAL_PATH = /^\/api\/v1\/workers\/\{workerId\}\/assignments\/[A-Za-z0-9_-]{1,128}\/cli-credentials$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WRITE_BACK_TIMEOUT_MS = 15_000;
const WRITE_BACK_ATTEMPTS = 3;

/**
 * Whether an assignment payload's `cliCredentials` has the expected shape.
 *
 * @param value - The raw `payload.cliCredentials` value.
 * @returns True when it carries a reference and a credential path.
 */
export function isCliCredentialsPayload(value: unknown): value is CliCredentialsPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.ref === 'string' && candidate.ref.length > 0 && typeof candidate.path === 'string';
}

/**
 * Builds a credential URL under the worker's API base, keeping any base path
 * prefix (e.g. `/cloud`). Only the exact credential route is accepted, so the
 * worker token and reference can never be sent to another origin or route.
 */
function credentialUrl(worker: CloudWorkerRecord, template: string, credentialId?: string): string {
  if (!CREDENTIAL_PATH.test(template)) {
    throw new Error('cliCredentials.path is not the worker credential route');
  }
  if (credentialId !== undefined && !CREDENTIAL_ID.test(credentialId)) {
    throw new Error('Invalid CLI credential id');
  }
  const base = new URL(worker.baseUrl);
  const relative = template.replace('{workerId}', encodeURIComponent(worker.workerId));
  const url = new URL(
    `${worker.baseUrl.replace(/\/+$/, '')}${relative}${credentialId === undefined ? '' : `/${credentialId}`}`
  );
  if (url.origin !== base.origin || url.search || url.hash) {
    throw new Error('cliCredentials.path resolves outside the control plane');
  }
  return url.toString();
}

function headers(worker: CloudWorkerRecord, ref: string, json = false): Headers {
  const result = new Headers({ Authorization: `Bearer ${worker.workerToken}`, 'X-Cli-Credential-Ref': ref });
  if (json) result.set('Content-Type', 'application/json');
  return result;
}

/**
 * Fetches the run's subscription logins and writes each auth file 0600 into a
 * 0700 directory under `<runDir>/.cli-home`.
 *
 * A file is mounted only when it matches a credential the assignment payload
 * listed, with that credential's CLI and the CLI's own layout; anything else is
 * skipped (and logged by CLI name only).
 *
 * @param input.worker - The authenticated worker (token sent with the request).
 * @param input.credentials - The payload's `cliCredentials`.
 * @param input.runDir - The run's private directory.
 * @returns The env for relayflows, the login directory, and the mounted files.
 * @throws When the control plane refuses the reference or the path is not the credential route.
 */
export async function materializeCliCredentials(input: {
  worker: CloudWorkerRecord;
  credentials: CliCredentialsPayload;
  runDir: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  log?: (...args: unknown[]) => void;
}): Promise<MaterializedCliCredentials> {
  const response = await input.fetchImpl(credentialUrl(input.worker, input.credentials.path), {
    method: 'GET',
    headers: headers(input.worker, input.credentials.ref),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Could not load the run's CLI logins (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as { files?: CredentialFile[]; skipped?: Array<{ reason?: string }> };
  const expected = new Map((input.credentials.credentials ?? []).map((entry) => [entry.credentialId, entry.cli]));
  const home = path.join(input.runDir, '.cli-home');
  await fsp.mkdir(home, { recursive: true, mode: 0o700 });
  await fsp.chmod(home, 0o700).catch(() => undefined);
  const env: Record<string, string> = {};
  const files: MaterializedCliCredentials['files'] = [];
  for (const entry of body.files ?? []) {
    const layout = CLI_LAYOUTS[entry.cli];
    const valid =
      layout !== undefined &&
      typeof entry.credentialId === 'string' &&
      CREDENTIAL_ID.test(entry.credentialId) &&
      expected.get(entry.credentialId) === entry.cli &&
      entry.homeEnv === layout.homeEnv &&
      entry.directory === layout.directory &&
      entry.file === layout.file &&
      typeof entry.content === 'string' &&
      !(layout.homeEnv in env);
    if (!valid || !layout) {
      input.log?.(`[cloud-worker] skipping a CLI login that does not match the assignment (${String(entry.cli)})`);
      continue;
    }
    const directory = path.join(home, layout.directory);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.chmod(directory, 0o700).catch(() => undefined);
    const filePath = path.join(directory, layout.file);
    await fsp.writeFile(filePath, entry.content, { encoding: 'utf-8', mode: 0o600 });
    await fsp.chmod(filePath, 0o600).catch(() => undefined);
    env[layout.homeEnv] = directory;
    files.push({ credentialId: entry.credentialId, cli: entry.cli, filePath, original: entry.content });
  }
  if (files.length) env[SUBSCRIPTION_LOGINS_ENV] = [...new Set(files.map((file) => file.cli))].sort().join(',');
  if (body.skipped?.length) {
    input.log?.(`[cloud-worker] ${body.skipped.length} CLI login(s) unavailable for this run`);
  }
  return { env, home, files };
}

/** Reads a regular file without following a symlink a workflow may have planted. */
async function readRegularFile(filePath: string): Promise<string | null> {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  if (!noFollow) {
    const stat = await fsp.lstat(filePath).catch(() => null);
    if (!stat?.isFile()) return null;
  }
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    return await handle.readFile({ encoding: 'utf-8' });
  } finally {
    await handle.close();
  }
}

/**
 * After the run, sends back each auth file the CLI rewrote (its own token
 * refresh), so the stored login keeps a live refresh token. Each PUT has its
 * own timeout and is retried; it never waits on the run's abort signal, so a
 * cancelled run still stores a rotated (single-use) refresh token.
 *
 * @returns How many files were stored, and which changed files could not be.
 */
export async function writeBackCliCredentials(input: {
  worker: CloudWorkerRecord;
  credentials: CliCredentialsPayload;
  materialized: MaterializedCliCredentials;
  fetchImpl: typeof fetch;
  log?: (...args: unknown[]) => void;
  retryDelayMs?: number;
}): Promise<CliCredentialWriteBack> {
  const result: CliCredentialWriteBack = { written: 0, failed: [] };
  for (const file of input.materialized.files) {
    const current = await readRegularFile(file.filePath);
    if (current === null || current === file.original) continue;
    let stored = false;
    for (let attempt = 1; attempt <= WRITE_BACK_ATTEMPTS && !stored; attempt += 1) {
      try {
        const response = await input.fetchImpl(
          credentialUrl(input.worker, input.credentials.path, file.credentialId),
          {
            method: 'PUT',
            headers: headers(input.worker, input.credentials.ref, true),
            body: JSON.stringify({ content: current }),
            signal: AbortSignal.timeout(WRITE_BACK_TIMEOUT_MS),
          }
        );
        if (response.ok) stored = true;
        // A 4xx will not succeed on retry.
        else if (response.status < 500 && response.status !== 429) break;
      } catch {
        // Network failure or timeout: retry.
      }
      if (!stored && attempt < WRITE_BACK_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, (input.retryDelayMs ?? 1_000) * attempt));
      }
    }
    if (stored) {
      result.written += 1;
    } else {
      result.failed.push({ credentialId: file.credentialId, cli: file.cli });
      input.log?.(
        `[cloud-worker] the refreshed ${file.cli} login could not be stored; sign in again if the next run fails`
      );
    }
  }
  return result;
}
