/**
 * Shared broker-connection discovery for the attach-style CLI verbs
 * (`view`, `drive`, `passthrough`).
 *
 * Resolution order matches `agent-relay-broker dump-pty` so users don't
 * have to learn two patterns:
 *
 *   1. `--broker-url` / `--api-key` CLI flags
 *   2. `RELAY_BROKER_URL` / `RELAY_BROKER_API_KEY` environment variables
 *   3. `<state-dir>/connection.json` (default `.agentworkforce/relay/connection.json`)
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
 *
 * URL and API key are not resolved independently past the explicit tier.
 * A process that is itself a relay agent carries its own broker's
 * `RELAY_BROKER_API_KEY` in env; if that key got paired with a URL that
 * resolved from a *different* source (typically another repo's
 * `connection.json`, e.g. `agent-relay node agent attach` against another
 * repo's broker), the pair can never authenticate (#1382). Once the URL
 * resolves from env or the connection file, the key must resolve from that
 * same tier (or an explicit `--api-key` override) — never reach past it
 * into a different tier. An explicit `--broker-url` is exempt: it is a
 * deliberate, single-field override, and the key still resolves normally
 * beneath it (env, then file) so `--broker-url` alone does not force the
 * caller to also pass `--api-key`.
 */
export function resolveBrokerConnection(
  options: BrokerConnectionOptions,
  deps: BrokerConnectionDeps
): BrokerConnection | null {
  const explicitUrl = trimOrUndefined(options.brokerUrl);
  const envUrl = trimOrUndefined(deps.env.RELAY_BROKER_URL);
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : deps.getDefaultStateDir();
  const connectionFile = deps.readConnectionFile(stateDir);
  const fileUrl = readString(connectionFile, 'url');

  const explicitKey = trimOrUndefined(options.apiKey);
  const envKey = trimOrUndefined(deps.env.RELAY_BROKER_API_KEY);
  const fileKey = readString(connectionFile, 'api_key');

  let url: string | undefined;
  let apiKey: string | undefined;
  if (explicitUrl) {
    url = explicitUrl;
    apiKey = explicitKey ?? envKey ?? fileKey;
  } else if (envUrl) {
    url = envUrl;
    apiKey = explicitKey ?? envKey;
  } else if (fileUrl) {
    url = fileUrl;
    apiKey = explicitKey ?? fileKey;
  }
  if (!url) return null;

  return {
    url: url.replace(/\/+$/, ''),
    apiKey,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  };
}

/** Convert an `http(s)://host:port` base URL to the matching `ws(s)://…/ws`. */
export function toWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/ws`;
}
