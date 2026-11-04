// Subscription-login materialisation for `agent-relay cloud worker`.
//
// A control plane that holds Codex/Grok subscription logins for the workspace
// (self-hosted relaycontrol; hosted Cloud mounts the same files in its own
// sandboxes) puts `cliCredentials` in the assignment payload: a short-lived,
// run-scoped reference, never the files. Before spawning relayflows, the worker
// exchanges the reference (with its worker token) for the auth files, writes
// each one 0600 into a 0700 directory inside the run's private dir, and points
// the CLI at it (CODEX_HOME / GROK_HOME). After the run it writes back a file
// the CLI refreshed, so the stored login keeps a live refresh token. The run
// dir, and the files with it, are deleted after the run.
//
// Nothing here logs a file's content or the reference.
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { CloudWorkerRecord } from '@agent-relay/cloud';

export type CliCredentialsPayload = {
  ref: string;
  expiresAt?: string;
  /** Path template with `{workerId}`. */
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

export type MaterializedCliCredentials = {
  env: Record<string, string>;
  files: Array<{ credentialId: string; cli: string; filePath: string; original: string }>;
};

/** The only env names a materialised login may set. */
const ALLOWED_HOME_ENV = new Set(['CODEX_HOME', 'GROK_HOME']);
const SAFE_SEGMENT = /^\.?[A-Za-z0-9_-]{1,64}(\.json)?$/;

/** Env flag relayflows reads to give the subscription precedence over API keys. */
export const SUBSCRIPTION_LOGINS_ENV = 'AGENT_RELAY_SUBSCRIPTION_LOGINS';

export function isCliCredentialsPayload(value: unknown): value is CliCredentialsPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.ref === 'string' && candidate.ref.length > 0 && typeof candidate.path === 'string';
}

function credentialUrl(worker: CloudWorkerRecord, template: string, suffix = ''): string {
  const relative = template.replace('{workerId}', encodeURIComponent(worker.workerId));
  // Only same-origin, relative API paths: the reference is never sent elsewhere.
  if (!relative.startsWith('/api/')) throw new Error('cliCredentials.path must be a relative /api/ path');
  return new URL(`${relative}${suffix}`, worker.baseUrl.endsWith('/') ? worker.baseUrl : `${worker.baseUrl}/`).toString();
}

function headers(worker: CloudWorkerRecord, ref: string, json = false): Headers {
  const result = new Headers({ Authorization: `Bearer ${worker.workerToken}`, 'X-Cli-Credential-Ref': ref });
  if (json) result.set('Content-Type', 'application/json');
  return result;
}

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
  const home = path.join(input.runDir, '.cli-home');
  await fsp.mkdir(home, { recursive: true, mode: 0o700 });
  await fsp.chmod(home, 0o700).catch(() => undefined);
  const env: Record<string, string> = {};
  const files: MaterializedCliCredentials['files'] = [];
  for (const entry of body.files ?? []) {
    if (
      !ALLOWED_HOME_ENV.has(entry.homeEnv) ||
      !SAFE_SEGMENT.test(entry.directory) ||
      !SAFE_SEGMENT.test(entry.file) ||
      typeof entry.content !== 'string'
    ) {
      input.log?.(`[cloud-worker] skipping a CLI login with an unexpected layout (${entry.cli ?? 'unknown'})`);
      continue;
    }
    const directory = path.join(home, entry.directory);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.chmod(directory, 0o700).catch(() => undefined);
    const filePath = path.join(directory, entry.file);
    await fsp.writeFile(filePath, entry.content, { encoding: 'utf-8', mode: 0o600 });
    await fsp.chmod(filePath, 0o600).catch(() => undefined);
    env[entry.homeEnv] = directory;
    files.push({ credentialId: entry.credentialId, cli: entry.cli, filePath, original: entry.content });
  }
  if (files.length) env[SUBSCRIPTION_LOGINS_ENV] = [...new Set(files.map((file) => file.cli))].sort().join(',');
  if (body.skipped?.length) {
    input.log?.(`[cloud-worker] ${body.skipped.length} CLI login(s) unavailable for this run`);
  }
  return { env, files };
}

/** After the run: send back any auth file the CLI rewrote (token refresh). */
export async function writeBackCliCredentials(input: {
  worker: CloudWorkerRecord;
  credentials: CliCredentialsPayload;
  materialized: MaterializedCliCredentials;
  fetchImpl: typeof fetch;
  log?: (...args: unknown[]) => void;
}): Promise<number> {
  let written = 0;
  for (const file of input.materialized.files) {
    let current: string;
    try {
      current = await fsp.readFile(file.filePath, 'utf-8');
    } catch {
      continue;
    }
    if (current === file.original) continue;
    try {
      const response = await input.fetchImpl(
        credentialUrl(input.worker, input.credentials.path, `/${encodeURIComponent(file.credentialId)}`),
        {
          method: 'PUT',
          headers: headers(input.worker, input.credentials.ref, true),
          body: JSON.stringify({ content: current }),
        }
      );
      if (response.ok) written += 1;
      else input.log?.(`[cloud-worker] ${file.cli} login write-back failed (HTTP ${response.status})`);
    } catch {
      input.log?.(`[cloud-worker] ${file.cli} login write-back failed`);
    }
  }
  return written;
}
