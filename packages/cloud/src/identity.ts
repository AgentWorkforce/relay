/**
 * Cloud identity store.
 *
 * `cloud-auth.json` holds *credentials*; this module holds the *identity* those
 * credentials resolve to — the user, their email, and their current
 * organization. It is written once at login (and refreshed by
 * `agent-relay cloud whoami`) so that every later CLI/broker/SDK process can
 * attribute telemetry to a real person and org without spending a round trip.
 *
 * Deliberately separate from `StoredAuth`:
 *   - the token-refresh path rebuilds `StoredAuth` from the refresh response, so
 *     extra fields there would be silently dropped;
 *   - telemetry code needs to read identity, and it should never have to open a
 *     file containing refresh tokens.
 *
 * Everything here is best-effort. A missing, unreadable, or malformed identity
 * file degrades to "anonymous machine" telemetry — it never fails a command.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type CloudIdentity = {
  /** Cloud user id. The only required field — it is the PostHog person key. */
  userId: string;
  email?: string;
  name?: string;
  organizationId?: string;
  organizationSlug?: string;
  organizationName?: string;
  organizationRole?: string;
  /** Cloud (SaaS) workspace id — NOT a relaycast workspace id. */
  workspaceId?: string;
  /** Cloud API base URL this identity was resolved against. */
  apiUrl: string;
  /** ISO timestamp of the last successful resolve. */
  updatedAt: string;
};

/** Env vars that carry identity to child processes (broker, spawned agents). */
export const IDENTITY_ENV_KEYS = {
  userId: 'AGENT_RELAY_USER_ID',
  email: 'AGENT_RELAY_USER_EMAIL',
  organizationId: 'AGENT_RELAY_ORG_ID',
  organizationSlug: 'AGENT_RELAY_ORG_SLUG',
  workspaceId: 'AGENT_RELAY_CLOUD_WORKSPACE_ID',
} as const;

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.agentworkforce/relay');
const IDENTITY_FILE_NAME = 'cloud-identity.json';

/** Canonical identity file path, for display in `whoami` / `session` output. */
export const IDENTITY_FILE_PATH = path.join(DEFAULT_DATA_DIR, IDENTITY_FILE_NAME);

export function identityFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.AGENT_RELAY_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  return path.join(dataDir, IDENTITY_FILE_NAME);
}

/**
 * Values are forwarded as HTTP headers and PostHog properties, so they must be
 * free of control characters and bounded in length. Anything that fails is
 * dropped rather than truncated into something misleading.
 */
const IDENTITY_VALUE_ALLOWED = /^[\x20-\x7E]+$/;

function sanitize(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!IDENTITY_VALUE_ALLOWED.test(trimmed)) return undefined;
  return trimmed.slice(0, maxLength);
}

/**
 * Coerce an arbitrary object into a `CloudIdentity`, dropping any field that
 * doesn't survive sanitization. Returns null when there is no usable `userId`.
 */
export function normalizeCloudIdentity(value: unknown): CloudIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const userId = sanitize(raw.userId, 128);
  if (!userId) return null;

  const apiUrl = sanitize(raw.apiUrl, 512);
  const updatedAt = sanitize(raw.updatedAt, 40);

  return {
    userId,
    ...(sanitize(raw.email, 320) ? { email: sanitize(raw.email, 320)! } : {}),
    ...(sanitize(raw.name, 120) ? { name: sanitize(raw.name, 120)! } : {}),
    ...(sanitize(raw.organizationId, 128) ? { organizationId: sanitize(raw.organizationId, 128)! } : {}),
    ...(sanitize(raw.organizationSlug, 120)
      ? { organizationSlug: sanitize(raw.organizationSlug, 120)! }
      : {}),
    ...(sanitize(raw.organizationName, 200)
      ? { organizationName: sanitize(raw.organizationName, 200)! }
      : {}),
    ...(sanitize(raw.organizationRole, 60) ? { organizationRole: sanitize(raw.organizationRole, 60)! } : {}),
    ...(sanitize(raw.workspaceId, 128) ? { workspaceId: sanitize(raw.workspaceId, 128)! } : {}),
    apiUrl: apiUrl ?? '',
    updatedAt: updatedAt ?? new Date(0).toISOString(),
  };
}

/** Async read, for command paths that are already async. */
export async function readStoredIdentity(
  env: NodeJS.ProcessEnv = process.env
): Promise<CloudIdentity | null> {
  try {
    const file = await fsp.readFile(identityFilePath(env), 'utf8');
    const raw = JSON.parse(file);
    if ((raw._analyticsRevision ?? '') !== identityRevision(env)) return null;
    return normalizeCloudIdentity(raw);
  } catch {
    return null;
  }
}

/**
 * Sync read, for the CLI bootstrap path. Bootstrap has to publish identity into
 * `process.env` before it spawns anything, and it is synchronous.
 */
export function readStoredIdentitySync(env: NodeJS.ProcessEnv = process.env): CloudIdentity | null {
  try {
    const file = fs.readFileSync(identityFilePath(env), 'utf8');
    const raw = JSON.parse(file);
    if ((raw._analyticsRevision ?? '') !== identityRevision(env)) return null;
    return normalizeCloudIdentity(raw);
  } catch {
    return null;
  }
}

/** Logout/login invalidates in-flight whoami responses across processes. */
export function identityRevision(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return fs.readFileSync(`${identityFilePath(env)}.generation`, 'utf8');
  } catch {
    return '';
  }
}

function rotateIdentityRevision(env: NodeJS.ProcessEnv): string {
  const target = `${identityFilePath(env)}.generation`;
  const revision = randomUUID();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, revision, { mode: 0o600 });
  return revision;
}

export async function writeStoredIdentity(
  identity: CloudIdentity,
  env: NodeJS.ProcessEnv = process.env,
  expectedRevision?: string
): Promise<void> {
  const normalized = normalizeCloudIdentity(identity);
  if (!normalized) return;

  const target = identityFilePath(env);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;

  try {
    // Bind the record to the generation observed before whoami. Even if logout
    // happens during an awaited file write, readers reject the stale snapshot.
    const revision = expectedRevision ?? rotateIdentityRevision(env);
    if (revision !== identityRevision(env)) return;
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      tmp,
      `${JSON.stringify({ ...normalized, _analyticsRevision: revision }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await fsp.rename(tmp, target);
    if (identityRevision(env) === revision) publishCloudIdentity(normalized, env);
  } catch {
    // Identity is an analytics convenience — never fail a command over it.
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function clearStoredIdentity(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  publishCloudIdentity(null, env);
  try {
    rotateIdentityRevision(env);
    await fsp.rm(identityFilePath(env), { force: true });
  } catch {
    // Best-effort.
  }
}

/** Local login identity is authoritative. Inherited IDs are correlation hints,
 * never proof that this process is still logged in as the same account. */
export function resolveCloudIdentity(env: NodeJS.ProcessEnv = process.env): CloudIdentity | null {
  // Delegated credentials may belong to someone other than the local login.
  if (env.CLOUD_API_ACCESS_TOKEN?.trim()) return null;
  return readStoredIdentitySync(env);
}

/** Surface-local eligibility, shared with the CLI preference file. */
export function isCloudAnalyticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const disabled = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true';
  if (disabled(env.AGENT_RELAY_TELEMETRY_DISABLED) || disabled(env.DO_NOT_TRACK)) return false;
  try {
    const prefs = JSON.parse(
      fs.readFileSync(path.join(path.dirname(identityFilePath(env)), 'telemetry.json'), 'utf8')
    );
    return prefs.enabled !== false;
  } catch (error) {
    // Only a genuinely absent preference file inherits the default. Corrupt or
    // unreadable consent must not enable Cloud profile repair.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Replace, rather than merge, child context so logout/workspace changes clear
 * stale values. These are hints at remote boundaries, not authorization. */
export function publishCloudIdentity(
  identity: CloudIdentity | null,
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const key of [...Object.values(IDENTITY_ENV_KEYS), 'AGENT_RELAY_DISTINCT_ID']) delete env[key];
  if (!isCloudAnalyticsEnabled(env)) return;
  Object.assign(env, cloudIdentityEnv(identity));
  if (identity) env.AGENT_RELAY_DISTINCT_ID = identity.userId;
}

/** The env vars a parent process should publish so children inherit identity. */
export function cloudIdentityEnv(identity: CloudIdentity | null): Record<string, string> {
  if (!identity) return {};
  return {
    [IDENTITY_ENV_KEYS.userId]: identity.userId,
    ...(identity.organizationId ? { [IDENTITY_ENV_KEYS.organizationId]: identity.organizationId } : {}),
    ...(identity.organizationSlug ? { [IDENTITY_ENV_KEYS.organizationSlug]: identity.organizationSlug } : {}),
    ...(identity.workspaceId ? { [IDENTITY_ENV_KEYS.workspaceId]: identity.workspaceId } : {}),
  };
}

/**
 * Stable fingerprint of the identity-derived PostHog state. Emitters compare it
 * against the last value they sent so `$identify` / `$groupidentify` are
 * re-issued when the user switches org (or their email changes) — and skipped
 * on every other run.
 */
export function cloudIdentityFingerprint(identity: CloudIdentity | null): string | undefined {
  if (!identity) return undefined;
  return [
    identity.userId,
    identity.email ?? '',
    identity.organizationId ?? '',
    identity.organizationSlug ?? '',
  ].join('|');
}
