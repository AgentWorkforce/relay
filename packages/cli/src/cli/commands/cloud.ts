import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';

import {
  ensureAuthenticated,
  ensureCloudSession,
  authorizedApiFetch,
  readStoredAuth,
  clearStoredAuth,
  defaultApiUrl,
  AUTH_FILE_PATH,
  REFRESH_WINDOW_MS,
  runWorkflow,
  scheduleWorkflow,
  listWorkflowSchedules,
  getRunStatus,
  getRunLogs,
  syncWorkflowPatch,
  cancelWorkflow,
  connectProvider,
  getProviderHelpText,
  normalizeProvider,
  enrollFleetNode,
  upsertFleetNodeEnrollment,
  redactCredentialValues,
  toCloudIdentity,
  writeStoredIdentity,
  IDENTITY_FILE_PATH,
  type WhoAmIResponse,
  type WorkflowFileType,
  type WorkflowSchedule,
} from '@agent-relay/cloud';

import { defaultExit } from '../lib/exit.js';
import { sanitizeForTerminalLine } from '../lib/formatting.js';
import { maskSecret } from '../lib/redact.js';
import { errorClassName } from '../lib/telemetry-helpers.js';
import { track } from '../telemetry/index.js';
import { registerCloudRoomCommands } from './cloud-room.js';
import { registerCloudIntegrationCommands } from './cloud-integration.js';
import { registerCloudWorkerCommands } from './cloud-worker.js';

const CLOUD_SYNC_PATCH_EXCLUDES = [
  '.agent-bin/**',
  '.relayfile.acl',
  '.relayfile-mount-state.json',
  '.relayfile-mount-state.json.tmp-*',
  '.trajectories/**',
  '.workflow-context/**',
] as const;

export function buildCloudSyncPatchExcludeArgs(): string {
  return CLOUD_SYNC_PATCH_EXCLUDES.map((pattern) => `--exclude=${JSON.stringify(pattern)}`).join(' ');
}

// ── Types ────────────────────────────────────────────────────────────────────

type ExitFn = (code: number) => never;

export interface CloudDependencies {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  ensureCloudSession: typeof ensureCloudSession;
  authorizedApiFetch: typeof authorizedApiFetch;
  enrollFleetNode: typeof enrollFleetNode;
  upsertFleetNodeEnrollment: typeof upsertFleetNodeEnrollment;
  /**
   * Persist redeemed-but-unstorable enrollment credentials to a 0600 recovery
   * file and return its path. Kept injectable so tests can simulate the
   * "recovery write also failed" last resort.
   */
  writeEnrollmentRecoveryFile: (record: unknown) => string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function withDefaults(overrides: Partial<CloudDependencies> = {}): CloudDependencies {
  return {
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ensureCloudSession,
    authorizedApiFetch,
    enrollFleetNode,
    upsertFleetNodeEnrollment,
    writeEnrollmentRecoveryFile: (record: unknown) => {
      // The tmpdir is a different filesystem/permission domain than the failed
      // enrollment store, so this write usually succeeds when the store's did not.
      const file = path.join(
        os.tmpdir(),
        `agent-relay-enrollment-recovery-${process.pid}-${Date.now()}.json`
      );
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return file;
    },
    ...overrides,
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }
  return parsed;
}

function parseWorkflowFileType(value: string): WorkflowFileType {
  if (value === 'yaml' || value === 'ts' || value === 'py') {
    return value;
  }
  throw new InvalidArgumentError('Expected workflow type to be one of: yaml, ts, py');
}

function parseEnvAssignment(value: string, previous: Record<string, string> = {}): Record<string, string> {
  const equalsIndex = value.indexOf('=');
  if (equalsIndex <= 0) {
    throw new InvalidArgumentError('Expected environment assignment in KEY=VALUE form.');
  }

  const key = value.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new InvalidArgumentError(`Invalid environment variable name: ${key || '(empty)'}`);
  }

  return {
    ...previous,
    [key]: value.slice(equalsIndex + 1),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type MintedFleetNodeEnrollment = {
  token: string;
  enrollmentUrl: string;
};

type CloudAuth = Awaited<ReturnType<typeof ensureCloudSession>>['auth'];

type ResolvedCloudWorkspace = {
  cloudWorkspaceId: string;
  auth: CloudAuth;
};

/** One entry of `GET /api/v1/workspaces` — the workspaces this login can use. */
type CloudWorkspaceSummary = {
  id: string;
  slug: string;
  name: string;
};

const CLOUD_WORKSPACE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIFIED_WORKSPACE_ID_PATTERN = /^rw_[a-z0-9]{8}$/;

const WORKSPACE_SELECTOR_HELP =
  "Run 'agent-relay cloud workspaces' to list the workspaces this login can use.";

/**
 * True when the value carries a live credential prefix. A pasted secret must
 * never be treated as a workspace name: name resolution matches locally
 * against the listing, but reporting "no workspace named X" would echo it.
 */
function looksLikeCredential(value: string): boolean {
  return redactCredentialValues(value) !== value;
}

function isCloudLoginError(error: unknown): boolean {
  if (!isObject(error) || typeof error.code !== 'string') {
    return false;
  }
  return error.code === 'AUTH_BROWSER_REQUIRED' || error.code === 'AUTH_REFRESH_EXPIRED';
}

function enrollmentTokenMintError(response: Response, payload: unknown, workspaceId: string): Error {
  if (response.status === 401) {
    return new Error('Cloud login required. Run `agent-relay cloud login` and retry.');
  }
  if (response.status === 403) {
    return new Error(
      `You do not have permission to enroll nodes in workspace ${workspaceId}. ` +
        'An organization owner or admin must run this command.'
    );
  }
  if (response.status === 404) {
    return new Error(`Workspace ${workspaceId} was not found. Check the workspace ID and retry.`);
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')?.trim();
    return new Error(
      `Cloud enrollment token rate limit exceeded.${
        retryAfter ? ` Retry-After: ${retryAfter} seconds.` : ' Wait and retry.'
      }`
    );
  }

  const detail =
    isObject(payload) && typeof payload.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : `${response.status} ${response.statusText}`.trim();
  return new Error(`Failed to mint a Cloud enrollment token: ${detail}`);
}

function workspaceResolveError(response: Response): Error {
  if (response.status === 401) {
    return new Error('Cloud login required. Run `agent-relay cloud login` and retry.');
  }
  if (response.status === 403) {
    return new Error('You do not have access to that Cloud workspace.');
  }
  if (response.status === 404) {
    return new Error(
      'The workspace identifier was not found by Agent Relay Cloud. ' +
        'Use a Cloud workspace UUID or unified rw_ workspace ID.'
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')?.trim();
    return new Error(
      `Cloud workspace resolution rate limit exceeded.${
        retryAfter ? ` Retry-After: ${retryAfter} seconds.` : ' Wait and retry.'
      }`
    );
  }

  const detail = `${response.status} ${response.statusText}`.trim();
  return new Error(`Failed to resolve the Cloud workspace: ${detail}`);
}

async function resolveCloudWorkspace(
  workspaceId: string,
  auth: CloudAuth,
  deps: Pick<CloudDependencies, 'authorizedApiFetch'>
): Promise<ResolvedCloudWorkspace> {
  const { response, auth: activeAuth } = await deps.authorizedApiFetch(
    auth,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve`,
    { method: 'GET' },
    { interactive: false }
  );
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw workspaceResolveError(response);
  }
  if (!isObject(payload) || typeof payload.cloudWorkspaceId !== 'string') {
    throw new Error('Cloud workspace resolver returned an invalid response.');
  }

  const cloudWorkspaceId = payload.cloudWorkspaceId.trim();
  if (!CLOUD_WORKSPACE_UUID_PATTERN.test(cloudWorkspaceId)) {
    throw new Error('Cloud workspace resolver returned an invalid response.');
  }

  return { cloudWorkspaceId, auth: activeAuth };
}

function workspaceListError(response: Response): Error {
  if (response.status === 401) {
    return new Error('Cloud login required. Run `agent-relay cloud login` and retry.');
  }
  if (response.status === 403) {
    return new Error('This login is not allowed to list Cloud workspaces.');
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')?.trim();
    return new Error(
      `Cloud workspace list rate limit exceeded.${
        retryAfter ? ` Retry-After: ${retryAfter} seconds.` : ' Wait and retry.'
      }`
    );
  }

  const detail = `${response.status} ${response.statusText}`.trim();
  return new Error(`Failed to list Cloud workspaces: ${detail}`);
}

function toWorkspaceSummary(entry: unknown): CloudWorkspaceSummary | null {
  if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id.trim()) {
    return null;
  }
  const id = entry.id.trim();
  const slug = typeof entry.slug === 'string' && entry.slug.trim() ? entry.slug.trim() : id;
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : slug;
  return { id, slug, name };
}

/**
 * List the Cloud workspaces reachable from the stored login. This is the only
 * discovery path the CLI has for workspace IDs, so both `cloud workspaces` and
 * name-based `--workspace` resolution go through it.
 */
async function listCloudWorkspaces(
  auth: CloudAuth,
  deps: Pick<CloudDependencies, 'authorizedApiFetch'>
): Promise<{ workspaces: CloudWorkspaceSummary[]; auth: CloudAuth }> {
  const { response, auth: activeAuth } = await deps.authorizedApiFetch(
    auth,
    '/api/v1/workspaces',
    { method: 'GET' },
    { interactive: false }
  );
  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw workspaceListError(response);
  }
  if (!isObject(payload) || !Array.isArray(payload.workspaces)) {
    throw new Error('Cloud workspace list returned an invalid response.');
  }

  const workspaces = payload.workspaces
    .map(toWorkspaceSummary)
    .filter((entry): entry is CloudWorkspaceSummary => entry !== null);

  return { workspaces, auth: activeAuth };
}

/**
 * Match a user-supplied selector against the listing. ID beats slug beats
 * name so an exact identifier is never shadowed by someone else's display
 * name, and each tier is matched case-insensitively.
 */
function matchWorkspaceSelector(
  selector: string,
  workspaces: CloudWorkspaceSummary[]
): CloudWorkspaceSummary[] {
  const needle = selector.trim().toLowerCase();
  for (const field of ['id', 'slug', 'name'] as const) {
    const matches = workspaces.filter((workspace) => workspace[field].toLowerCase() === needle);
    if (matches.length > 0) {
      return matches;
    }
  }
  return [];
}

/**
 * Turn `--workspace` into an identifier the resolver accepts. UUIDs and
 * unified `rw_` IDs pass straight through; anything else is looked up by name
 * or slug against the login's workspace listing.
 */
async function resolveWorkspaceSelector(
  selector: string,
  auth: CloudAuth,
  deps: Pick<CloudDependencies, 'authorizedApiFetch'>
): Promise<{ workspaceId: string; auth: CloudAuth }> {
  if (CLOUD_WORKSPACE_UUID_PATTERN.test(selector) || UNIFIED_WORKSPACE_ID_PATTERN.test(selector)) {
    return { workspaceId: selector, auth };
  }

  const listed = await listCloudWorkspaces(auth, deps);
  const matches = matchWorkspaceSelector(selector, listed.workspaces);

  if (matches.length === 1) {
    return { workspaceId: matches[0].id, auth: listed.auth };
  }
  if (matches.length > 1) {
    throw new Error(
      `That name matches ${matches.length} Cloud workspaces (${matches
        .map((workspace) => workspace.id)
        .join(', ')}). Pass the workspace ID instead.`
    );
  }

  // Nothing matched. The credential check only picks the error message — it
  // must not gate the lookup, because the redactor's prefixes are deliberately
  // broad and a real workspace may legitimately be named `br_team`. Neither
  // message echoes the selector: an unmatched value may be a pasted secret.
  throw new Error(
    looksLikeCredential(selector)
      ? `That value looks like a credential, not a workspace. Pass a workspace name, Cloud workspace UUID, or unified rw_ workspace ID. ${WORKSPACE_SELECTOR_HELP}`
      : `No Cloud workspace matched that name. ${WORKSPACE_SELECTOR_HELP}`
  );
}

async function mintFleetNodeEnrollment(
  options: { workspaceId: string; name?: string; maxAgents?: number },
  deps: Pick<CloudDependencies, 'ensureCloudSession' | 'authorizedApiFetch'>
): Promise<MintedFleetNodeEnrollment> {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) {
    throw new Error('A workspace name or ID is required for session-based enrollment.');
  }

  try {
    const session = await deps.ensureCloudSession({
      apiUrl: defaultApiUrl(),
      interactive: false,
    });
    const selected = await resolveWorkspaceSelector(workspaceId, session.auth, deps);
    const resolved = await resolveCloudWorkspace(selected.workspaceId, selected.auth, deps);
    const { response } = await deps.authorizedApiFetch(
      resolved.auth,
      '/api/v1/fleet/enrollment-tokens',
      {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: resolved.cloudWorkspaceId,
          ...(options.name ? { name: options.name } : {}),
          ...(options.maxAgents !== undefined ? { maxAgents: options.maxAgents } : {}),
        }),
      },
      { interactive: false }
    );
    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      // Report the resolved identifier, never the raw selector: by this point
      // the selector has matched a real workspace, so the ID is safe to echo.
      throw enrollmentTokenMintError(response, payload, selected.workspaceId);
    }
    if (
      !isObject(payload) ||
      typeof payload.token !== 'string' ||
      !payload.token.trim() ||
      typeof payload.enrollmentUrl !== 'string' ||
      !payload.enrollmentUrl.trim()
    ) {
      throw new Error('Cloud enrollment token response is missing the token or enrollment URL.');
    }

    return {
      token: payload.token.trim(),
      enrollmentUrl: payload.enrollmentUrl.trim(),
    };
  } catch (error) {
    if (isCloudLoginError(error)) {
      throw new Error('Cloud login required. Run `agent-relay cloud login` and retry.');
    }
    throw error;
  }
}

async function resolveFleetNodeEnrollmentInput(
  options: {
    token?: string;
    workspace?: string;
    enrollmentUrl?: string;
    name?: string;
    maxAgents?: number;
  },
  deps: Pick<CloudDependencies, 'ensureCloudSession' | 'authorizedApiFetch'>
): Promise<{ enrollmentToken: string; enrollmentUrl: string }> {
  if (!options.token && !options.workspace) {
    throw new Error('Either --token or --workspace is required to enroll a fleet node.');
  }
  if (!options.workspace) {
    return {
      enrollmentToken: options.token ?? '',
      enrollmentUrl: options.enrollmentUrl ?? '',
    };
  }

  const minted = await mintFleetNodeEnrollment(
    {
      workspaceId: options.workspace,
      ...(options.name ? { name: options.name } : {}),
      ...(options.maxAgents !== undefined ? { maxAgents: options.maxAgents } : {}),
    },
    deps
  );
  return {
    enrollmentToken: minted.token,
    enrollmentUrl: minted.enrollmentUrl,
  };
}

/**
 * Render `name (id)` for whoami, or `(none)` when the login has no selection.
 * The ID is Cloud-provided text like the name, so it is sanitized too.
 */
function formatWorkspaceLabel(entry: { id: string; name?: string | null } | null | undefined): string {
  if (!entry) {
    return '(none)';
  }
  const name = entry.name?.trim() ? sanitizeForTerminalLine(entry.name.trim()) : '(no name)';
  return `${name} (${sanitizeForTerminalLine(entry.id)})`;
}

function renderWorkspaceList(workspaces: CloudWorkspaceSummary[], log: (...args: unknown[]) => void): void {
  if (workspaces.length === 0) {
    log('No Cloud workspaces are available to this login.');
    return;
  }

  // Sanitize before measuring: padding computed from raw text would be wrong
  // for any row whose displayed form is shorter than its stored form.
  const rows = workspaces.map((workspace) => ({
    id: sanitizeForTerminalLine(workspace.id),
    slug: sanitizeForTerminalLine(workspace.slug),
    name: sanitizeForTerminalLine(workspace.name),
  }));
  const idWidth = Math.max(...rows.map((row) => row.id.length));
  const slugWidth = Math.max(...rows.map((row) => row.slug.length));
  for (const row of rows) {
    log(`${row.id.padEnd(idWidth)}  ${row.slug.padEnd(slugWidth)}  ${row.name}`);
  }
  log("\nPass an ID or a name to 'agent-relay cloud enroll --workspace'.");
}

function renderPatchPushResults(patches: unknown, log: (...args: unknown[]) => void): void {
  if (!isObject(patches)) {
    return;
  }

  const entries = Object.entries(patches);
  if (entries.length === 0) {
    return;
  }

  log('Patches:');
  for (const [name, rawEntry] of entries) {
    if (!isObject(rawEntry)) {
      log(`  ${name}: patch pending - run still active`);
      continue;
    }

    const pushedTo = rawEntry.pushedTo;
    if (isObject(pushedTo) && typeof pushedTo.prUrl === 'string') {
      const branch = typeof pushedTo.branch === 'string' ? ` (${pushedTo.branch})` : '';
      log(`  ${name}: ${pushedTo.prUrl}${branch}`);
      continue;
    }

    const pushError = rawEntry.pushError;
    if (isObject(pushError)) {
      const code = typeof pushError.code === 'string' ? pushError.code : 'unknown';
      const message = typeof pushError.message === 'string' ? pushError.message : 'push failed';
      log(`  ${name}: push failed: ${code}: ${message}`);
      continue;
    }

    log(`  ${name}: patch pending - run still active`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatScheduleCadence(schedule: WorkflowSchedule): string {
  if (schedule.scheduleType === 'cron') {
    return `${schedule.cronExpression ?? 'cron'} (${schedule.timezone})`;
  }
  return schedule.scheduledAt
    ? `${schedule.scheduledAt} (${schedule.timezone})`
    : `once (${schedule.timezone})`;
}

function renderSchedule(schedule: WorkflowSchedule, log: (...args: unknown[]) => void): void {
  log(`Schedule created: ${schedule.id}`);
  log(`Name: ${schedule.name}`);
  log(`Status: ${schedule.status}`);
  log(`Cadence: ${formatScheduleCadence(schedule)}`);
}

function renderScheduleList(schedules: WorkflowSchedule[], log: (...args: unknown[]) => void): void {
  if (schedules.length === 0) {
    log('No workflow schedules found.');
    return;
  }

  for (const schedule of schedules) {
    const lastRun = schedule.lastTriggeredRunId ? ` last run ${schedule.lastTriggeredRunId}` : ' no runs yet';
    log(
      `${schedule.id}  ${schedule.status}  ${formatScheduleCadence(schedule)}  ${schedule.name} (${lastRun})`
    );
  }
}

// ── Command registration ─────────────────────────────────────────────────────

export function registerCloudCommands(program: Command, overrides: Partial<CloudDependencies> = {}): void {
  const deps = withDefaults(overrides);

  const cloudCommand = program
    .command('cloud')
    .description('Cloud account, provider auth, and workflow commands');

  registerCloudWorkerCommands(cloudCommand, deps);
  registerCloudRoomCommands(cloudCommand, deps);
  registerCloudIntegrationCommands(cloudCommand, deps);

  // ── login ──────────────────────────────────────────────────────────────────

  cloudCommand
    .command('login')
    .description('Authenticate with Agent Relay Cloud via browser (alias of `relay login`)')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--force', 'Force re-authentication even if already logged in')
    .action(async (options: { apiUrl?: string; force?: boolean }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const apiUrl = options.apiUrl || defaultApiUrl();

        if (!options.force) {
          const existing = await readStoredAuth();
          if (existing && existing.apiUrl === apiUrl) {
            const expiresAt = Date.parse(existing.accessTokenExpiresAt);
            if (!Number.isNaN(expiresAt) && expiresAt - Date.now() > REFRESH_WINDOW_MS) {
              deps.log(`Already logged in to ${existing.apiUrl}`);
              success = true;
              return;
            }
          }
        }

        await ensureAuthenticated(apiUrl, { force: options.force });
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'login',
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── logout ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('logout')
    .description('Clear stored cloud credentials')
    .action(async () => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const auth = await readStoredAuth();
        if (!auth) {
          deps.log('Not logged in.');
          success = true;
          return;
        }

        try {
          const revokeUrl = new URL(
            'api/v1/auth/token/revoke',
            auth.apiUrl.endsWith('/') ? auth.apiUrl : `${auth.apiUrl}/`
          );
          await fetch(revokeUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: auth.refreshToken }),
          });
        } catch {
          // best-effort revoke
        }

        await clearStoredAuth();
        deps.log('Logged out.');
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'logout',
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── whoami ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('session')
    .description('Show the canonical Agent Relay Cloud session')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the session as JSON (access token masked unless --reveal-token)')
    .option('--reveal-token', 'Include the raw access token in --json output')
    .option(
      '--refresh-timeout <milliseconds>',
      'Timeout for refreshing the cloud session',
      parsePositiveInteger
    )
    .action(
      async (options: {
        apiUrl?: string;
        json?: boolean;
        revealToken?: boolean;
        refreshTimeout?: number;
      }) => {
        const apiUrl = options.apiUrl || defaultApiUrl();
        const session = await ensureCloudSession({
          apiUrl,
          interactive: false,
          refreshTimeoutMs: options.refreshTimeout,
        });

        if (options.json) {
          deps.log(
            JSON.stringify(
              {
                apiUrl: session.auth.apiUrl,
                accessToken: options.revealToken
                  ? session.auth.accessToken
                  : maskSecret(session.auth.accessToken),
                accessTokenExpiresAt: session.auth.accessTokenExpiresAt,
                ...(session.auth.refreshTokenExpiresAt
                  ? { refreshTokenExpiresAt: session.auth.refreshTokenExpiresAt }
                  : {}),
              },
              null,
              2
            )
          );
          return;
        }

        deps.log(`API URL: ${session.auth.apiUrl}`);
        deps.log(`Access token expires: ${session.auth.accessTokenExpiresAt}`);
        if (session.auth.refreshTokenExpiresAt) {
          deps.log(`Refresh token expires: ${session.auth.refreshTokenExpiresAt}`);
        }
        deps.log(`Token file: ${AUTH_FILE_PATH}`);
      }
    );

  cloudCommand
    .command('whoami')
    .description('Show current authentication status')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (options: { apiUrl?: string }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const apiUrl = options.apiUrl || defaultApiUrl();
        const auth = await ensureAuthenticated(apiUrl);
        const { response } = await authorizedApiFetch(auth, '/api/v1/auth/whoami', {
          method: 'GET',
        });

        const payload = (await response.json().catch(() => null)) as
          | (WhoAmIResponse & { error?: string })
          | null;

        if (!response.ok || !payload?.authenticated) {
          throw new Error(payload?.error || 'Failed to resolve auth status');
        }

        deps.log(`API URL: ${auth.apiUrl}`);
        deps.log(`Auth source: ${payload.source}`);
        deps.log(`Subject type: ${payload.subjectType ?? 'session'}`);
        deps.log(
          `User: ${payload.user.name || '(no name)'}${payload.user.email ? ` <${payload.user.email}>` : ''}`
        );
        // Print IDs, not just names: the workspace ID is what `cloud enroll`
        // and the other workspace-scoped commands take, and whoami is where
        // people look for it first.
        deps.log(`Organization: ${formatWorkspaceLabel(payload.currentOrganization)}`);
        deps.log(`Workspace: ${formatWorkspaceLabel(payload.currentWorkspace)}`);
        deps.log(`Scopes: ${payload.scopes.length > 0 ? payload.scopes.join(', ') : '(none)'}`);
        deps.log(`Token file: ${AUTH_FILE_PATH}`);

        // whoami is the canonical "who am I" call, so make it the refresh point
        // for the locally cached identity that tags telemetry.
        const identity = toCloudIdentity(payload, auth.apiUrl);
        if (identity) {
          await writeStoredIdentity(identity);
          deps.log(`Identity file: ${IDENTITY_FILE_PATH}`);
        }
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'whoami',
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── workspaces ─────────────────────────────────────────────────────────────

  cloudCommand
    .command('workspaces')
    .description('List the Cloud workspaces this login can use, with their IDs')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (options: { apiUrl?: string; json?: boolean }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const session = await deps.ensureCloudSession({
          apiUrl: options.apiUrl || defaultApiUrl(),
          interactive: false,
        });
        const { workspaces } = await listCloudWorkspaces(session.auth, deps);

        if (options.json) {
          deps.log(JSON.stringify({ workspaces }, null, 2));
        } else {
          renderWorkspaceList(workspaces, deps.log);
        }
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        deps.error(
          isCloudLoginError(err)
            ? 'Cloud login required. Run `agent-relay cloud login` and retry.'
            : err instanceof Error
              ? err.message
              : String(err)
        );
        deps.exit(1);
      } finally {
        track('cloud_auth', {
          action: 'workspaces',
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── connect ────────────────────────────────────────────────────────────────

  cloudCommand
    .command('connect')
    .description('Connect a provider via interactive SSH session')
    .argument('<provider>', `Provider to connect (${getProviderHelpText()})`)
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--language <language>', 'Sandbox language/image', 'typescript')
    .option('--timeout <seconds>', 'Connection timeout in seconds', parsePositiveInteger, 300)
    .action(async (providerArg: string, options: { apiUrl?: string; language: string; timeout: number }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      const trackedProvider = normalizeProvider(providerArg);
      try {
        const result = await connectProvider({
          provider: providerArg,
          apiUrl: options.apiUrl,
          language: options.language,
          timeoutMs: options.timeout * 1000,
          io: { log: deps.log, error: deps.error },
        });
        success = result.success;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'connect',
          success,
          duration_ms: Date.now() - started,
          provider: trackedProvider,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  // ── enroll ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('enroll')
    .description('Enroll this machine as a Cloud-managed fleet node')
    .addOption(
      new Option('--token <token>', 'One-time Cloud enrollment token (ocl_node_enr_...)').conflicts(
        'workspace'
      )
    )
    .addOption(
      new Option(
        '--workspace <workspace>',
        'Workspace name, Cloud workspace UUID, or unified rw_ ID to mint into using the stored login'
      ).conflicts('token')
    )
    .option('--enrollment-url <url>', 'Cloud enrollment endpoint that redeems the token')
    .option('--name <name>', 'Override the node name')
    .option('--max-agents <n>', 'Maximum managed agents for this node', parsePositiveInteger)
    .option('--json', 'Print the persisted enrollment record as JSON (never the token)', false)
    .action(
      async (options: {
        token?: string;
        workspace?: string;
        enrollmentUrl?: string;
        name?: string;
        maxAgents?: number;
        json?: boolean;
      }) => {
        try {
          const { enrollmentToken, enrollmentUrl } = await resolveFleetNodeEnrollmentInput(options, deps);

          const enrollment = await deps.enrollFleetNode({
            enrollmentToken,
            enrollmentUrl,
            ...(options.name ? { name: options.name } : {}),
            ...(options.maxAgents !== undefined ? { maxAgents: options.maxAgents } : {}),
          });
          const record = { ...enrollment, enrolledAt: new Date().toISOString() };
          // Persist BEFORE printing success: the enrollment token is one-time, so
          // durable credentials must hit disk before we report success. If the
          // write fails the token is already burned, so dump the credentials
          // (token included) for manual recovery instead of losing them forever.
          try {
            deps.upsertFleetNodeEnrollment(record);
          } catch (persistErr) {
            deps.error(
              `Enrollment succeeded but persisting credentials failed: ${
                persistErr instanceof Error ? persistErr.message : String(persistErr)
              }`
            );
            // The one-time token is already consumed, so the credentials must
            // survive somewhere. Prefer a 0600 recovery file (never print the
            // token); dump to stderr only if even that write fails — losing
            // the credentials entirely is the strictly worse outcome.
            try {
              const recoveryPath = deps.writeEnrollmentRecoveryFile(record);
              deps.error(
                `The one-time enrollment token has been consumed. Credentials were saved to ${recoveryPath} (owner-only permissions).`
              );
              deps.error(
                "Fix the store problem and re-add them from that file, or export RELAY_NODE_TOKEN/RELAY_NODE_ID/RELAY_BASE_URL from it before 'relay node up'. Delete the file afterwards."
              );
            } catch {
              deps.error(
                'The one-time enrollment token has been consumed and a recovery file could not be written. SAVE THESE CREDENTIALS NOW:'
              );
              deps.error(JSON.stringify(record, null, 2));
              deps.error(
                "Export RELAY_NODE_TOKEN/RELAY_NODE_ID/RELAY_BASE_URL from them before 'relay node up'."
              );
            }
            deps.exit(1);
            return;
          }

          if (options.json) {
            // Never print the node token, even in JSON mode.
            const { nodeToken: _nodeToken, ...safe } = record;
            void _nodeToken;
            deps.log(JSON.stringify(safe, null, 2));
            return;
          }

          const nodeIdSuffix = record.nodeId ? ` (${record.nodeId})` : '';
          deps.log(
            `Enrolled node "${record.nodeName}"${nodeIdSuffix} in workspace ${record.relayWorkspaceId}. ` +
              "Run 'relay node up' to serve it."
          );
        } catch (err) {
          deps.error(err instanceof Error ? err.message : String(err));
          deps.exit(1);
        }
      }
    );

  // ── run ────────────────────────────────────────────────────────────────────

  cloudCommand
    .command('run')
    .description('Submit a workflow run')
    .argument('<workflow>', 'Workflow file path or inline workflow content')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--file-type <type>', 'Workflow type: yaml, ts, or py', parseWorkflowFileType)
    .option('--sync-code', 'Upload the current working directory before running')
    .option('--no-sync-code', 'Skip uploading the current working directory')
    .option('--resume <runId>', 'Resume a previously failed cloud workflow run from where it left off')
    .option('--start-from <step>', 'Start from a specific step in cloud and skip predecessor steps')
    .option(
      '--previous-run-id <runId>',
      'Use cached outputs from a previous cloud run when starting from a step'
    )
    .option('--json', 'Print raw JSON response', false)
    .action(
      async (
        workflow: string,
        options: {
          apiUrl?: string;
          fileType?: WorkflowFileType;
          syncCode?: boolean;
          resume?: string;
          startFrom?: string;
          previousRunId?: string;
          json?: boolean;
        }
      ) => {
        const started = Date.now();
        let success = false;
        let errorClass: string | undefined;
        try {
          const result = await runWorkflow(workflow, options);
          if (options.json) {
            deps.log(JSON.stringify(result, null, 2));
          } else {
            deps.log(`Run created: ${result.runId}`);
            if (typeof result.sandboxId === 'string') {
              deps.log(`Sandbox: ${result.sandboxId}`);
            }
            deps.log(`Status: ${result.status}`);
            renderPatchPushResults(result.patches, deps.log);
            deps.log(`\nView logs:  agent-relay cloud logs ${result.runId} --follow`);
            deps.log(`Sync code:  agent-relay cloud sync ${result.runId}`);
          }
          success = true;
        } catch (err) {
          errorClass = errorClassName(err);
          throw err;
        } finally {
          track('cloud_workflow_run', {
            has_explicit_file_type: Boolean(options.fileType),
            sync_code: options.syncCode !== false,
            json_output: Boolean(options.json),
            success,
            duration_ms: Date.now() - started,
            ...(errorClass ? { error_class: errorClass } : {}),
          });
        }
      }
    );

  // ── schedule ───────────────────────────────────────────────────────────────

  cloudCommand
    .command('schedule')
    .description('Schedule a repeatable workflow run')
    .argument('<workflow>', 'Workflow file path or inline workflow content')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--file-type <type>', 'Workflow type: yaml, ts, or py', parseWorkflowFileType)
    .option('--cron <expression>', 'Cron expression, for example "0 * * * *"')
    .option('--at <isoTimestamp>', 'One-time ISO timestamp, for example 2026-05-10T09:00:00Z')
    .option('--timezone <timezone>', 'IANA timezone for cron schedules', 'UTC')
    .option('--name <name>', 'Schedule name')
    .option('--description <description>', 'Schedule description')
    .option(
      '--env <KEY=VALUE>',
      'Environment variable to pass to scheduled runs; repeat for multiple variables',
      parseEnvAssignment,
      {}
    )
    .option('--json', 'Print raw JSON response', false)
    .action(
      async (
        workflow: string,
        options: {
          apiUrl?: string;
          fileType?: WorkflowFileType;
          cron?: string;
          at?: string;
          timezone?: string;
          name?: string;
          description?: string;
          env?: Record<string, string>;
          json?: boolean;
        }
      ) => {
        const started = Date.now();
        let success = false;
        let errorClass: string | undefined;
        try {
          const { env, ...scheduleOptions } = options;
          const result = await scheduleWorkflow(workflow, {
            ...scheduleOptions,
            ...(env && Object.keys(env).length > 0 ? { envSecrets: env } : {}),
          });
          if (options.json) {
            deps.log(JSON.stringify(result, null, 2));
          } else {
            renderSchedule(result, deps.log);
            deps.log('\nList schedules:  agent-relay cloud schedules');
          }
          success = true;
        } catch (err) {
          errorClass = errorClassName(err);
          throw err;
        } finally {
          track('cloud_workflow_schedule', {
            schedule_type: options.cron ? 'cron' : 'once',
            has_explicit_file_type: Boolean(options.fileType),
            json_output: Boolean(options.json),
            success,
            duration_ms: Date.now() - started,
            ...(errorClass ? { error_class: errorClass } : {}),
          });
        }
      }
    );

  cloudCommand
    .command('schedules')
    .description('List scheduled workflow runs')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (options: { apiUrl?: string; json?: boolean }) => {
      const schedules = await listWorkflowSchedules(options);
      if (options.json) {
        deps.log(JSON.stringify({ schedules }, null, 2));
        return;
      }
      renderScheduleList(schedules, deps.log);
    });

  // ── status ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('status')
    .description('Fetch workflow run status')
    .argument('<runId>', 'Workflow run id')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (runId: string, options: { apiUrl?: string; json?: boolean }) => {
      const result = await getRunStatus(runId, options);
      if (options.json) {
        deps.log(JSON.stringify(result, null, 2));
        return;
      }

      deps.log(`Run: ${result.runId ?? runId}`);
      deps.log(`Status: ${result.status ?? 'unknown'}`);
      if (typeof result.sandboxId === 'string') {
        deps.log(`Sandbox: ${result.sandboxId}`);
      }
      if (typeof result.updatedAt === 'string') {
        deps.log(`Updated: ${result.updatedAt}`);
      }
      renderPatchPushResults(result.patches, deps.log);
    });

  // ── logs ───────────────────────────────────────────────────────────────────

  cloudCommand
    .command('logs')
    .description('Read workflow run logs')
    .argument('<runId>', 'Workflow run id')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--follow', 'Poll until the run is done', false)
    .option('--poll-interval <seconds>', 'Polling interval while following', parsePositiveInteger, 2)
    .option('--offset <bytes>', 'Start reading logs from a byte offset', parseNonNegativeInteger, 0)
    .option('--agent <name>', 'Read logs for a specific agent')
    .option('--sandbox-id <sandboxId>', 'Read logs for a specific step sandbox')
    .option('--json', 'Print raw JSON responses', false)
    .action(
      async (
        runId: string,
        options: {
          apiUrl?: string;
          follow?: boolean;
          pollInterval?: number;
          offset?: number;
          agent?: string;
          sandboxId?: string;
          json?: boolean;
        }
      ) => {
        let offset = options.offset ?? 0;
        const sandboxId = options.agent ?? options.sandboxId;

        while (true) {
          const result = await getRunLogs(runId, {
            apiUrl: options.apiUrl,
            offset,
            sandboxId,
          });

          if (options.json) {
            deps.log(JSON.stringify(result, null, 2));
          } else if (result.content) {
            process.stdout.write(result.content);
          }

          offset = result.offset;
          if (!options.follow || result.done) {
            break;
          }

          await sleep((options.pollInterval ?? 2) * 1000);
        }
      }
    );

  // ── sync ───────────────────────────────────────────────────────────────────

  cloudCommand
    .command('sync')
    .description('Download and apply code changes from a completed workflow run')
    .argument('<runId>', 'Workflow run id')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--dir <path>', 'Local directory to apply the patch to', '.')
    .option('--dry-run', 'Download and display the patch without applying', false)
    .action(async (runId: string, options: { apiUrl?: string; dir?: string; dryRun?: boolean }) => {
      const targetDir = path.resolve(options.dir ?? '.');
      deps.log(`Fetching patch for run ${runId}...`);

      const result = await syncWorkflowPatch(runId, { apiUrl: options.apiUrl });

      // Multi-path responses target different repos and can't be applied to a
      // single --dir. Surface them in dry-run, otherwise direct the user to
      // apply manually. Single-patch runs continue to apply automatically.
      if (result.patches) {
        const entries = Object.entries(result.patches);
        const withChanges = entries.filter(([, p]) => p.hasChanges);
        if (withChanges.length === 0) {
          deps.log('No changes to sync — the workflow did not modify any files.');
          return;
        }
        if (options.dryRun) {
          for (const [name, p] of withChanges) {
            deps.log(`\n--- Patch for "${name}" (dry run) ---`);
            process.stdout.write(p.patch);
            deps.log(`\n--- End patch for "${name}" ---`);
          }
          return;
        }
        deps.error(
          `This run produced ${withChanges.length} per-path patch${withChanges.length === 1 ? '' : 'es'} ` +
            `(${withChanges.map(([n]) => n).join(', ')}). "cloud sync" only applies single-patch runs. ` +
            `Use --dry-run to inspect each patch, then apply manually in the correct repo.`
        );
        deps.exit(1);
        return;
      }

      if (!result.hasChanges || !result.patch) {
        deps.log('No changes to sync — the workflow did not modify any files.');
        return;
      }

      if (typeof result.patch !== 'string' || !result.patch) {
        throw new Error('Server reported changes but returned no patch data. The response may be malformed.');
      }

      if (options.dryRun) {
        deps.log('\n--- Patch (dry run) ---');
        process.stdout.write(result.patch);
        deps.log('\n--- End patch ---');
        return;
      }

      const { execSync } = await import('node:child_process');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sync-'));
      const tmpPatch = path.join(tmpDir, 'changes.patch');
      fs.writeFileSync(tmpPatch, result.patch, { mode: 0o600 });

      try {
        const excludeArgs = buildCloudSyncPatchExcludeArgs();
        const stat = execSync(`git apply ${excludeArgs} --stat "${tmpPatch}"`, {
          cwd: targetDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (stat.trim()) {
          deps.log('\nFiles changed by agent:');
          deps.log(stat);
        }

        execSync(`git apply ${excludeArgs} "${tmpPatch}"`, {
          cwd: targetDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        deps.log('Patch applied successfully.');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`Failed to apply patch: ${message}`);
        deps.error(`Patch saved to: ${tmpPatch}`);
        deps.exit(1);
      }
    });

  // ── cancel ─────────────────────────────────────────────────────────────────

  cloudCommand
    .command('cancel')
    .description('Cancel a running workflow')
    .argument('<runId>', 'Workflow run id')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (runId: string, options: { apiUrl?: string; json?: boolean }) => {
      const result = await cancelWorkflow(runId, options);
      if (options.json) {
        deps.log(JSON.stringify(result, null, 2));
        return;
      }

      deps.log(`Run: ${result.runId ?? runId}`);
      deps.log(`Status: ${result.status ?? 'unknown'}`);
    });
}
