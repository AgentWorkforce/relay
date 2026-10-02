/**
 * Shared broker-connection discovery for the attach-style CLI verbs
 * (`view`, `drive`, `passthrough`).
 *
 * Resolution order:
 *
 *   1. `--broker-url` / `--api-key` CLI flags
 *   2. `--state-dir <dir>` — that broker's `connection.json`, and nothing else
 *   3. `RELAY_BROKER_URL` / `RELAY_BROKER_API_KEY` environment variables
 *   4. The project default `.agentworkforce/relay/connection.json`
 *
 * An explicit `--state-dir` names one broker on purpose, so ambient env vars
 * must not silently redirect it to another one (relay#1822).
 */

import fs from 'node:fs';
import path from 'node:path';

import { getProjectPaths } from '@agent-relay/config';

/** Connection metadata discovered from `connection.json` or CLI/env overrides. */
export interface BrokerConnection {
  url: string;
  apiKey?: string;
  /** Optional per-request deadline for long-lived proxy connections. */
  requestTimeoutMs?: number;
}

/** Options the caller may have parsed from CLI flags. */
export interface BrokerConnectionOptions {
  brokerUrl?: string;
  apiKey?: string;
  stateDir?: string;
  /** Internal override used by bounded loopback proxies. */
  requestTimeoutMs?: number;
}

/** Injectable bits — tests stub these out instead of touching disk / env. */
export interface BrokerConnectionDeps {
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
}

/** Read `<state-dir>/connection.json` from disk, returning the parsed JSON or `null`. */
export function readConnectionFileFromDisk(stateDir: string): unknown {
  const connPath = path.join(stateDir, 'connection.json');
  try {
    const raw = fs.readFileSync(connPath, 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Locate the directory that actually holds a broker's `connection.json` for
 * a caller-supplied `--state-dir`.
 *
 * The broker writes `<state-dir>/connection.json`, but fleet nodes keep their
 * broker state in a `state/` child of the node directory
 * (`~/.agentworkforce/relay/<host>-node/state`), so operators routinely pass
 * the node directory instead. Accept that parent form as a fallback so the
 * same path a node was configured with reaches it (relay#1575). The exact
 * directory always wins when it has a connection file.
 */
export function resolveConnectionStateDir(
  stateDir: string,
  hasConnectionFile: (dir: string) => boolean = (dir) => fs.existsSync(path.join(dir, 'connection.json'))
): string {
  const resolved = path.resolve(stateDir);
  if (hasConnectionFile(resolved)) return resolved;
  const nested = path.join(resolved, 'state');
  return hasConnectionFile(nested) ? nested : resolved;
}

/** Default state-directory: `.agentworkforce/relay/` under the resolved project root. */
export function defaultStateDir(): string {
  const projectRoot = getProjectPaths().projectRoot;
  return path.join(projectRoot, '.agentworkforce/relay');
}

function isStringObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(obj: unknown, key: string): string | undefined {
  if (!isStringObject(obj)) return undefined;
  const value = obj[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Trim a possibly-undefined string and treat empty results as
 * `undefined` so `??` chains correctly fall through to lower-priority
 * sources. Plain `value?.trim()` would yield `""` for blank inputs,
 * which is not nullish — that would let an empty `--broker-url` flag
 * silently override a real `RELAY_BROKER_URL` env var, etc.
 */
function trimOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Resolve the broker connection in priority order. Returns `null` when no
 * source provides a URL — the caller decides how to surface that.
 */
export function resolveBrokerConnection(
  options: BrokerConnectionOptions,
  deps: BrokerConnectionDeps
): BrokerConnection | null {
  const explicitUrl = trimOrUndefined(options.brokerUrl);
  const explicitKey = trimOrUndefined(options.apiKey);
  const envKey = trimOrUndefined(deps.env.RELAY_BROKER_API_KEY);
  const finish = (url: string, apiKey: string | undefined): BrokerConnection => ({
    url: url.replace(/\/+$/, ''),
    apiKey,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });

  const explicitStateDir = trimOrUndefined(options.stateDir);
  if (explicitStateDir && !explicitUrl) {
    // The caller named this broker's state directory: its connection file is
    // the only source for both URL and key, so env vars pointing at another
    // broker cannot pair that broker's URL or key with this one.
    const stateDir = resolveConnectionStateDir(
      explicitStateDir,
      (dir) => readString(deps.readConnectionFile(dir), 'url') !== undefined
    );
    const connectionFile = deps.readConnectionFile(stateDir);
    const fileUrl = readString(connectionFile, 'url');
    if (!fileUrl) return null;
    return finish(fileUrl, explicitKey ?? readString(connectionFile, 'api_key'));
  }

  const envUrl = trimOrUndefined(deps.env.RELAY_BROKER_URL);
  const stateDir = explicitStateDir ? path.resolve(explicitStateDir) : deps.getDefaultStateDir();
  const connectionFile = deps.readConnectionFile(stateDir);
  const fileUrl = readString(connectionFile, 'url');

  const url = explicitUrl ?? envUrl ?? fileUrl;
  if (!url) return null;

  const fileKey = readString(connectionFile, 'api_key');
  return finish(url, explicitKey ?? envKey ?? fileKey);
}

/**
 * Explain a failed {@link resolveBrokerConnection} lookup by naming the path
 * that was searched and which input chose it. "No broker" and "looked in the
 * wrong place" have different remedies — only one warrants a restart.
 */
export function describeMissingBrokerConnection(
  options: Pick<BrokerConnectionOptions, 'stateDir'>,
  deps: Pick<BrokerConnectionDeps, 'getDefaultStateDir'>
): string {
  const explicitStateDir = trimOrUndefined(options.stateDir);
  if (explicitStateDir) {
    const resolved = path.resolve(explicitStateDir);
    return (
      `Error: no broker connection at ${path.join(resolved, 'connection.json')} (from --state-dir; ` +
      `also checked ${path.join(resolved, 'state', 'connection.json')}). ` +
      'Pass the same --state-dir the broker was started with.'
    );
  }
  return (
    `Error: no broker connection at ${path.join(deps.getDefaultStateDir(), 'connection.json')} (project default). ` +
    'If the broker was started with --state-dir, pass the same --state-dir here, ' +
    'or pass --broker-url / set RELAY_BROKER_URL.'
  );
}

/** Convert an `http(s)://host:port` base URL to the matching `ws(s)://…/ws`. */
export function toWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/ws`;
}
