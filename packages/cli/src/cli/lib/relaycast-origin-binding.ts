import fs from 'node:fs';
import { pbkdf2Sync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { withFileLock, writeFileAtomically } from './locked-json-file.js';

/**
 * Binds each Relaycast credential (workspace key or agent token) to the server
 * it was used with, so a credential minted by a self-hosted server is never
 * sent to the hosted gateway because `RELAY_BASE_URL` was left unset in a
 * later shell.
 *
 * The file stores a one-way fingerprint of each credential, never the
 * credential itself, mapped to the server's full base URL (origin plus any
 * path prefix). Only self-hosted servers are recorded: an unbound credential
 * with no configured URL keeps the SDK's hosted default, since nothing says it
 * belongs anywhere else.
 */
export const ORIGIN_BINDINGS_FILE = 'relaycast-origins.json';

const HOSTED_DEFAULT_ORIGIN = 'https://cast.agentrelay.com';
const BASE_URL_LABEL = 'The Relaycast base URL (--base-url or RELAY_BASE_URL)';
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;

interface OriginBindings {
  version: 1;
  origins: Record<string, string>;
}

/** Agent Relay's own gateways: cast, agent37-cast, dev-cast and the like. */
function isHostedOrigin(origin: string): boolean {
  const url = new URL(origin);
  return (
    url.protocol === 'https:' &&
    (url.hostname === 'agentrelay.com' || url.hostname.endsWith('.agentrelay.com'))
  );
}

/**
 * Where bindings are kept: next to the workspace store. A caller-supplied env
 * without AGENT_RELAY_HOME still honours the process's own, so a scoped env
 * cannot redirect this machine-wide record to the real home directory.
 *
 * @param env - Environment to read AGENT_RELAY_HOME from.
 * @returns Absolute path of the bindings file.
 */
export function originBindingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    env.AGENT_RELAY_HOME ?? process.env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
  return path.join(home, ORIGIN_BINDINGS_FILE);
}

/**
 * One-way fingerprint of a credential. Credentials are high-entropy random
 * secrets, so the key derivation is only there to keep the stored value
 * opaque; it mirrors the cleanup-scope digest in `commands/integration.ts`.
 */
function fingerprint(credential: string): string {
  return pbkdf2Sync(credential.trim(), 'agent-relay:relaycast-origin-binding', 10_000, 16, 'sha256').toString(
    'hex'
  );
}

function invalidFile(env: NodeJS.ProcessEnv, detail: string): Error {
  return new Error(
    `${originBindingsPath(env)} is not a valid Relaycast origin file (${detail}); fix or remove it.`
  );
}

function readBindings(env: NodeJS.ProcessEnv): OriginBindings {
  let raw: string;
  try {
    raw = fs.readFileSync(originBindingsPath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, origins: {} };
    throw new Error(`Could not read ${originBindingsPath(env)}; fix or remove it.`, { cause: error });
  }
  // A malformed file must fail closed: silently dropping entries would unbind
  // credentials and send them to the hosted default.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidFile(env, 'not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidFile(env, 'not an object');
  const { version, origins } = parsed as { version?: unknown; origins?: unknown };
  if (version !== 1) throw invalidFile(env, 'unknown version');
  if (!origins || typeof origins !== 'object' || Array.isArray(origins)) {
    throw invalidFile(env, '"origins" is not an object');
  }
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(origins as Record<string, unknown>)) {
    if (!FINGERPRINT_PATTERN.test(key)) throw invalidFile(env, `bad fingerprint "${key}"`);
    const baseUrl = savedBaseUrl(value);
    if (!baseUrl) throw invalidFile(env, `bad server for "${key}"`);
    validated[key] = baseUrl;
  }
  return { version: 1, origins: validated };
}

/** A saved binding's server, if it is a valid self-hosted base URL. */
function savedBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const baseUrl = configuredBaseUrl(value, 'A saved server');
    return baseUrl && !isHostedOrigin(baseUrl) ? baseUrl : undefined;
  } catch {
    return undefined;
  }
}

function writeBindings(bindings: OriginBindings, env: NodeJS.ProcessEnv): void {
  writeFileAtomically(originBindingsPath(env), `${JSON.stringify(bindings, null, 2)}\n`);
}

/** Read, change and rewrite the bindings while holding the cross-process lock. */
function updateBindings(env: NodeJS.ProcessEnv, change: (bindings: OriginBindings) => boolean): void {
  withFileLock(originBindingsPath(env), () => {
    const bindings = readBindings(env);
    if (change(bindings)) writeBindings(bindings, env);
  });
}

/**
 * The self-hosted server this credential was bound to, if any.
 *
 * @param credential - Workspace key or agent token.
 * @param env - Environment used to locate the bindings file.
 * @returns The bound base URL, or `undefined` when the credential is unbound.
 */
export function boundOrigin(credential: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readBindings(env).origins[fingerprint(credential)];
}

/**
 * Record that `credential` belongs to the self-hosted server at `baseUrl`.
 *
 * @param credential - Workspace key or agent token.
 * @param baseUrl - The server's base URL; validated and normalised before saving.
 * @param env - Environment used to locate the bindings file.
 */
export function bindOrigin(credential: string, baseUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const normalized = configuredBaseUrl(baseUrl, BASE_URL_LABEL);
  if (!normalized) throw new Error(`${BASE_URL_LABEL} is empty.`);
  if (isHostedOrigin(normalized)) throw new Error('Hosted servers are the default and are never bound.');
  const key = fingerprint(credential);
  updateBindings(env, (bindings) => {
    if (bindings.origins[key] === normalized) return false;
    bindings.origins[key] = normalized;
    return true;
  });
}

/**
 * Forget the binding for `credential`.
 *
 * @param credential - Workspace key or agent token.
 * @param env - Environment used to locate the bindings file.
 * @returns Whether a binding was removed.
 */
export function unbindOrigin(credential: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = fingerprint(credential);
  let removed = false;
  updateBindings(env, (bindings) => {
    if (!(key in bindings.origins)) return false;
    delete bindings.origins[key];
    removed = true;
    return true;
  });
  return removed;
}

function parseConfiguredUrl(value: string | undefined, label: string): URL | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain a query or fragment.`);
  }
  return parsed;
}

/**
 * Reduce a configured base URL to its origin. Blank means unset. A value that
 * is unparsable, not http(s), or carries credentials, a query or a fragment is
 * an error: falling back to the hosted default would send the credential
 * somewhere the caller did not choose.
 *
 * @param value - The configured URL, possibly blank.
 * @param label - How to name the setting in error messages.
 * @returns The URL's origin, or `undefined` when blank.
 */
export function configuredOrigin(value: string | undefined, label: string): string | undefined {
  return parseConfiguredUrl(value, label)?.origin;
}

/**
 * Like {@link configuredOrigin}, but keeps any path prefix (a server behind a
 * reverse proxy at `https://host/relaycast`), without a trailing slash.
 *
 * @param value - The configured URL, possibly blank.
 * @param label - How to name the setting in error messages.
 * @returns The normalised base URL, or `undefined` when blank.
 */
export function configuredBaseUrl(value: string | undefined, label: string): string | undefined {
  const parsed = parseConfiguredUrl(value, label);
  if (!parsed) return undefined;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Pick the server a credential may be sent to, and remember it.
 *
 * - A configured URL is used. A self-hosted one becomes the credential's
 *   binding; a hosted one clears any binding, since hosted is the default.
 * - With nothing configured, a bound credential goes back to its own server
 *   instead of the hosted default.
 * - Otherwise `undefined`: the SDK's hosted default applies.
 *
 * @param credential - Workspace key or agent token about to be sent.
 * @param requestedBaseUrl - The URL the caller explicitly chose, if any.
 * @param env - Environment used to locate the bindings file.
 * @returns The base URL to use, or `undefined` for the hosted default.
 */
export function guardCredentialOrigin(
  credential: string,
  requestedBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const requested = configuredBaseUrl(requestedBaseUrl, BASE_URL_LABEL);
  if (requested) {
    if (isHostedOrigin(requested)) unbindOrigin(credential, env);
    else bindOrigin(credential, requested, env);
    return requestedBaseUrl?.trim();
  }
  return boundOrigin(credential, env);
}

/**
 * Accept a destination the caller did not pick explicitly, such as a
 * persisted project route or the server of the workspace a saved token
 * belongs to. Only an explicit URL may move a binding, so a bound credential
 * whose destination disagrees is an error. An unbound credential headed to a
 * self-hosted server is bound to it, so it never falls back to hosted later.
 *
 * @param credential - Workspace key or agent token about to be sent.
 * @param baseUrl - The derived destination, or `undefined` for the hosted default.
 * @param env - Environment used to locate the bindings file.
 */
export function acceptDerivedDestination(
  credential: string,
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  const bound = boundOrigin(credential, env);
  const destination = baseUrl ? new URL(baseUrl).origin : HOSTED_DEFAULT_ORIGIN;
  if (!bound) {
    if (baseUrl && !isHostedOrigin(destination)) bindOrigin(credential, baseUrl, env);
    return;
  }
  if (new URL(bound).origin === destination) return;
  throw new Error(
    `This Relaycast credential belongs to ${new URL(bound).origin}, so it will not be sent to ${destination}. ` +
      `If it really belongs to ${destination} now, pass --base-url ${destination} once to move it.`
  );
}

/**
 * Fail before a server-side workspace is created if its key could not be
 * bound afterwards: a key that cannot be bound must not be minted, because an
 * unbound key falls back to the hosted default.
 *
 * @param baseUrl - The server the workspace will be created on.
 * @param env - Environment used to locate the bindings file.
 */
export function assertOriginBindingsWritable(baseUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  readBindings(env);
  const normalized = configuredBaseUrl(baseUrl, BASE_URL_LABEL);
  if (!normalized || isHostedOrigin(normalized)) return;
  const directory = path.dirname(originBindingsPath(env));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.accessSync(directory, fs.constants.W_OK);
}
