import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Binds each Relaycast credential (workspace key or agent token) to the server
 * origin it was used with, so a credential minted by a self-hosted server is
 * never sent to the hosted gateway because `RELAY_BASE_URL` was left unset in
 * a later shell.
 *
 * The file stores a one-way fingerprint of each credential, never the
 * credential itself. Only self-hosted origins are recorded: an unbound
 * credential with no configured URL keeps the SDK's hosted default, since
 * nothing says it belongs anywhere else.
 */
export const ORIGIN_BINDINGS_FILE = 'relaycast-origins.json';

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
 * Next to the workspace store. A caller-supplied env without AGENT_RELAY_HOME
 * still honours the process's own, so a scoped env cannot redirect this
 * machine-wide record to the real home directory.
 */
export function originBindingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    env.AGENT_RELAY_HOME ?? process.env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
  return path.join(home, ORIGIN_BINDINGS_FILE);
}

function fingerprint(credential: string): string {
  return createHash('sha256').update(credential.trim()).digest('hex').slice(0, 32);
}

function readBindings(env: NodeJS.ProcessEnv): OriginBindings {
  let raw: string;
  try {
    raw = fs.readFileSync(originBindingsPath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, origins: {} };
    throw new Error(`Could not read ${originBindingsPath(env)}; fix or remove it.`, { cause: error });
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OriginBindings>;
    if (parsed.version === 1 && parsed.origins && typeof parsed.origins === 'object') {
      return { version: 1, origins: { ...parsed.origins } };
    }
  } catch {
    // Reported below: an unreadable binding file must not silently unbind
    // every credential and send them to the hosted default.
  }
  throw new Error(`${originBindingsPath(env)} is not a valid Relaycast origin file; fix or remove it.`);
}

function writeBindings(bindings: OriginBindings, env: NodeJS.ProcessEnv): void {
  const file = originBindingsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(bindings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** The origin this credential was bound to, if any. */
export function boundOrigin(credential: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readBindings(env).origins[fingerprint(credential)];
}

/** Record that `credential` belongs to `origin`. */
export function bindOrigin(credential: string, origin: string, env: NodeJS.ProcessEnv = process.env): void {
  const bindings = readBindings(env);
  const key = fingerprint(credential);
  if (bindings.origins[key] === origin) return;
  bindings.origins[key] = origin;
  writeBindings(bindings, env);
}

/** Forget every binding for `credential`. */
export function unbindOrigin(credential: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const bindings = readBindings(env);
  const key = fingerprint(credential);
  if (!(key in bindings.origins)) return false;
  delete bindings.origins[key];
  writeBindings(bindings, env);
  return true;
}

/**
 * Reduce a configured base URL to its origin. Blank means unset. A value that
 * is unparsable, not http(s) or carries credentials is an error: falling back
 * to the hosted default would send the credential somewhere the caller did
 * not choose.
 */
export function configuredOrigin(value: string | undefined, label: string): string | undefined {
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
  return parsed.origin;
}

/**
 * Pick the origin a credential may be sent to, and remember it.
 *
 * - A configured URL is used. A self-hosted one becomes the credential's
 *   binding; a hosted one clears any binding, since hosted is the default.
 * - With nothing configured, a bound credential goes back to its own server
 *   instead of the hosted default.
 * - Otherwise `undefined`: the SDK's hosted default applies.
 */
export function guardCredentialOrigin(
  credential: string,
  requestedBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const requested = configuredOrigin(
    requestedBaseUrl,
    'The Relaycast base URL (--base-url or RELAY_BASE_URL)'
  );
  if (requested) {
    if (isHostedOrigin(requested)) unbindOrigin(credential, env);
    else bindOrigin(credential, requested, env);
    return requestedBaseUrl?.trim();
  }
  return boundOrigin(credential, env);
}
