import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { components } from './relayfile-contract/relayfile-control-plane-v1.gen.js';

/**
 * Typed client for the relayfile control-plane: HTTP/JSON over a local unix
 * domain socket (`relayfile control-plane serve`). This replaces the legacy
 * `spawn('relayfile', …)` + parse-stdout shell-out — the contract is now the
 * socket's request/response shapes, version-negotiated via `/v1/hello`.
 *
 * Transport is Node's built-in `http.request({ socketPath })` — no dependency,
 * unix-socket support is native.
 */

/** Control-plane API version this client speaks. Bump on a breaking wire change. */
export const RELAYFILE_API_VERSION = 1;

/**
 * Minimum `relayfile` daemon version the bridge requires. The control-plane
 * (and `resolve-path`/`--version`) first shipped in 0.10.16, so anything that
 * answers `/v1/hello` is already >= this — the check is belt-and-suspenders and
 * the bump point for future contract changes.
 */
export const MIN_RELAYFILE_VERSION = '0.10.16';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

/** First semver-looking token in a string (tolerates a leading `v` and surrounding words). */
export function firstSemver(value: string): string {
  for (const raw of value.split(/\s+/)) {
    const token = raw.replace(/^v/, '');
    if (SEMVER_RE.test(token)) return token;
  }
  return '';
}

/** Compare two semvers by numeric core; -1 / 0 / 1. Pre-release/build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const core = (v: string) =>
    v
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a0 = 0, a1 = 0, a2 = 0] = core(a);
  const [b0 = 0, b1 = 0, b2 = 0] = core(b);
  return a0 - b0 || a1 - b1 || a2 - b2;
}

/**
 * Pure version gate: throws an actionable error unless `version` (a daemon
 * version string) is a semver >= MIN_RELAYFILE_VERSION. Exported so the contract
 * it guards is unit-tested without a running daemon.
 */
export function assertRelayfileVersion(version: string): void {
  const parsed = firstSemver(version);
  if (!parsed || compareSemver(parsed, MIN_RELAYFILE_VERSION) < 0) {
    // Typed (not a bare Error) so callers that re-throw daemon/version failures
    // by code (e.g. resolveWritebackBinding) don't silently swallow it.
    throw new RelayfileControlPlaneError(
      'VERSION_INCOMPATIBLE',
      `relayfile >= ${MIN_RELAYFILE_VERSION} is required; found ${
        parsed ? `"${parsed}"` : `unparseable version "${version.trim()}"`
      }. Update relayfile (npm install -g relayfile@latest) or set RELAYFILE_BIN.`
    );
  }
}

/** Resolve the control-plane socket path, mirroring relayfile's Go default. */
export function defaultRelayfileSocketPath(): string {
  const explicit = process.env.RELAYFILE_SOCK?.trim();
  if (explicit) return explicit;
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg) return join(xdg, 'relayfile.sock');
  return join(tmpdir(), 'relayfile.sock');
}

function relayfileBinary(): string {
  return process.env.RELAYFILE_BIN?.trim() || 'relayfile';
}

/** Structured control-plane error carrying the daemon's typed code + HTTP status. */
export class RelayfileControlPlaneError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'RelayfileControlPlaneError';
  }
}

// Request/response types are DERIVED from the control-plane OpenAPI contract
// (relayfile-contract/relayfile-control-plane-v1.gen.ts, generated from the
// relayfile repo's openapi/relayfile-control-plane-v1.openapi.yaml via
// `npm run codegen:relayfile`). A field rename in the contract becomes a
// compile error here — the RFC's compile-time field-drift guarantee — while the
// real-daemon contract tests still cover semantic/transport drift.
type Schemas = components['schemas'];

export type HelloResponse = Schemas['HelloResponse'];
export type RelayfileBindingRecord = Schemas['Binding'];
export type ResolvePathResult = Schemas['ResolveResourcePathResponse'];
export type BindResult = Schemas['BindResponse'];
export type BindRequestBody = Schemas['BindRequest'];
export type ConnectRequestBody = Schemas['ConnectProviderRequest'];
export type ConnectResult = Schemas['ConnectProviderResponse'];
export type ProviderStatusResult = Schemas['ProviderStatus'];
export type WritebackSecretResult = Schemas['WritebackSecret'];

export interface RelayfileClientOptions {
  /** Socket to connect to. Defaults to defaultRelayfileSocketPath(). */
  socketPath?: string;
  /** Binary used to auto-start the daemon. Defaults to RELAYFILE_BIN or `relayfile`. */
  binary?: string;
  /**
   * Auto-start `relayfile control-plane serve` when the socket is absent.
   * Defaults to true unless RELAYFILE_REQUIRE_DAEMON=1 (strict, never-spawn mode).
   */
  autoStart?: boolean;
  /** How long to wait for an auto-started daemon to answer /v1/hello. */
  startTimeoutMs?: number;
  /** Per-request timeout. A hung socket rejects instead of blocking forever. */
  requestTimeoutMs?: number;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RelayfileControlPlaneClient {
  private readonly socketPath: string;
  private readonly binary: string;
  private readonly autoStart: boolean;
  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private ready: Promise<void> | undefined;

  constructor(options: RelayfileClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultRelayfileSocketPath();
    this.binary = options.binary ?? relayfileBinary();
    this.autoStart = options.autoStart ?? process.env.RELAYFILE_REQUIRE_DAEMON !== '1';
    this.startTimeoutMs = options.startTimeoutMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  }

  /** Low-level request over the unix socket. Throws RelayfileControlPlaneError. */
  private rawRequest<T>(opts: RequestOptions): Promise<T> {
    const query = opts.query
      ? Object.entries(opts.query)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const path = query ? `${opts.path}?${query}` : opts.path;
    const payload = opts.body == null ? undefined : JSON.stringify(opts.body);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const fail = (err: RelayfileControlPlaneError) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const ok = (value: T) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const req = request(
        {
          socketPath: this.socketPath,
          method: opts.method,
          path,
          timeout: this.requestTimeoutMs,
          headers: {
            'X-Relayfile-API-Version': String(RELAYFILE_API_VERSION),
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          // The response stream can emit 'error' (e.g. socket reset mid-body);
          // without a listener that's an unhandled error → crash.
          res.on('error', (err) =>
            fail(new RelayfileControlPlaneError('DAEMON_UNAVAILABLE', err.message))
          );
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              fail(
                new RelayfileControlPlaneError(
                  'DAEMON_UNAVAILABLE',
                  `relayfile control-plane returned non-JSON (status ${status}): ${text.slice(0, 200)}`,
                  status
                )
              );
              return;
            }
            if (status >= 200 && status < 300) {
              ok(parsed as T);
              return;
            }
            const err = (parsed as { error?: { code?: string; message?: string } })?.error;
            fail(
              new RelayfileControlPlaneError(
                err?.code ?? 'DAEMON_UNAVAILABLE',
                err?.message ?? `relayfile control-plane error (status ${status})`,
                status
              )
            );
          });
        }
      );
      // A hung socket (daemon wedged mid-handshake) must not block forever.
      req.on('timeout', () => {
        req.destroy(
          new RelayfileControlPlaneError(
            'DAEMON_UNAVAILABLE',
            `relayfile control-plane request timed out after ${this.requestTimeoutMs}ms (${opts.method} ${opts.path})`
          )
        );
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        // A RelayfileControlPlaneError here came from our own req.destroy(timeout).
        if (err instanceof RelayfileControlPlaneError) {
          fail(err);
          return;
        }
        // ENOENT (no socket file) / ECONNREFUSED (nothing listening) => daemon down.
        fail(
          new RelayfileControlPlaneError(
            'DAEMON_UNAVAILABLE',
            err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
              ? `relayfile control-plane is not running at ${this.socketPath} (${err.code})`
              : err.message,
            undefined
          )
        );
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Connect (auto-starting the daemon if configured), version-negotiating once. */
  async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.connectAndNegotiate().catch((err) => {
        // Don't cache a transient failure — let the next call retry.
        this.ready = undefined;
        throw err;
      });
    }
    return this.ready;
  }

  private async connectAndNegotiate(): Promise<void> {
    let hello: HelloResponse;
    try {
      hello = await this.hello();
    } catch (err) {
      if (!(err instanceof RelayfileControlPlaneError) || err.code !== 'DAEMON_UNAVAILABLE') throw err;
      if (!this.autoStart) {
        throw new RelayfileControlPlaneError(
          'DAEMON_UNAVAILABLE',
          `relayfile control-plane is not running at ${this.socketPath}. ` +
            `Start it with \`relayfile control-plane serve\` (or unset RELAYFILE_REQUIRE_DAEMON to auto-start).`
        );
      }
      hello = await this.startDaemonAndConnect();
    }
    if (!hello.supportedApiVersions?.includes(RELAYFILE_API_VERSION)) {
      throw new RelayfileControlPlaneError(
        'VERSION_INCOMPATIBLE',
        `relayfile daemon speaks API v${hello.apiVersion} (supports ${
          hello.supportedApiVersions?.join(', ') || 'none'
        }); this client needs v${RELAYFILE_API_VERSION}. Upgrade relayfile (or agent-relay).`
      );
    }
    assertRelayfileVersion(hello.daemonVersion);
  }

  private async startDaemonAndConnect(): Promise<HelloResponse> {
    let child;
    // A missing binary / bad RELAYFILE_BIN surfaces as an async 'error' event on
    // the child (ENOENT), NOT a throw from spawn(). Without a listener that's an
    // uncaught exception that crashes the CLI — capture it and fail fast instead.
    let spawnError: Error | undefined;
    try {
      child = spawn(this.binary, ['control-plane', 'serve', '--sock', this.socketPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        spawnError = err;
      });
    } catch (err) {
      throw new RelayfileControlPlaneError(
        'DAEMON_UNAVAILABLE',
        `failed to start relayfile control-plane (${err instanceof Error ? err.message : String(err)}). ` +
          `Install relayfile or set RELAYFILE_BIN.`
      );
    }
    child.unref?.();
    const deadline = Date.now() + this.startTimeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new RelayfileControlPlaneError(
          'DAEMON_UNAVAILABLE',
          `failed to start relayfile control-plane (${spawnError.message}). ` +
            `Install relayfile or set RELAYFILE_BIN.`
        );
      }
      await sleep(100);
      try {
        return await this.hello();
      } catch (err) {
        lastErr = err;
      }
    }
    throw new RelayfileControlPlaneError(
      'DAEMON_UNAVAILABLE',
      `relayfile control-plane did not become ready within ${this.startTimeoutMs}ms ` +
        `(${lastErr instanceof Error ? lastErr.message : String(lastErr)}).`
    );
  }

  // ── endpoints ──────────────────────────────────────────────────────────────

  hello(): Promise<HelloResponse> {
    return this.rawRequest<HelloResponse>({ method: 'GET', path: '/v1/hello' });
  }

  resolvePath(provider: string, resource: string): Promise<ResolvePathResult> {
    return this.request<ResolvePathResult>({
      method: 'POST',
      path: '/v1/integrations/resolve-path',
      body: { provider, resource },
    });
  }

  bind(input: BindRequestBody): Promise<BindResult> {
    return this.request<BindResult>({ method: 'POST', path: '/v1/integrations/bind', body: input });
  }

  async listBindings(): Promise<RelayfileBindingRecord[]> {
    const res = await this.request<{ bindings?: RelayfileBindingRecord[] }>({
      method: 'GET',
      path: '/v1/integrations/bindings',
    });
    return res.bindings ?? [];
  }

  unbind(provider: string, resource: string): Promise<unknown> {
    return this.request({ method: 'POST', path: '/v1/integrations/unbind', body: { provider, resource } });
  }

  /** Returns the connection status, or null when the provider is not connected. */
  async providerStatus(provider: string): Promise<ProviderStatusResult | null> {
    try {
      return await this.request<ProviderStatusResult>({
        method: 'GET',
        path: '/v1/integrations/provider-status',
        query: { provider },
      });
    } catch (err) {
      if (err instanceof RelayfileControlPlaneError && err.status === 404) return null;
      throw err;
    }
  }

  connect(input: ConnectRequestBody): Promise<ConnectResult> {
    return this.request<ConnectResult>({ method: 'POST', path: '/v1/integrations/connect', body: input });
  }

  writebackSecret(channel: string, workspace?: string): Promise<WritebackSecretResult> {
    return this.request<WritebackSecretResult>({
      method: 'POST',
      path: '/v1/integrations/writeback-secret',
      body: { channel, ...(workspace ? { workspace } : {}) },
    });
  }

  /** Endpoint request that ensures the daemon is up + version-compatible first. */
  private async request<T>(opts: RequestOptions): Promise<T> {
    await this.ensureReady();
    return this.rawRequest<T>(opts);
  }
}
