import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIN_RELAYFILE_VERSION, assertRelayfileVersion, defaultRelayfileBridge } from './integration.js';
import { RelayfileControlPlaneClient } from '@relayfile/client';

let socketSequence = 0;

async function withControlPlaneServer(
  handler: RequestListener,
  run: (socketPath: string) => Promise<void>
): Promise<void> {
  const socketPath = join(tmpdir(), `rf-negotiation-${process.pid}-${++socketSequence}.sock`);
  rmSync(socketPath, { force: true });
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  try {
    await run(socketPath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(socketPath, { force: true });
  }
}

function writeJson(response: Parameters<RequestListener>[1], status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function withFakeRelayfileBinary(
  version: string,
  run: (binary: string) => Promise<void>
): Promise<void> {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'rf-negotiation-bin-'));
  const binary = join(fixtureDir, 'relayfile');
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const { rmSync } = require('node:fs');
const { createServer } = require('node:http');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
if (args[0] !== 'control-plane' || args[1] !== 'serve') process.exit(2);
const socketIndex = args.indexOf('--sock');
const socketPath = socketIndex >= 0 ? args[socketIndex + 1] : undefined;
if (!socketPath) process.exit(2);

rmSync(socketPath, { force: true });
let closeTimer;
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/hello') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      daemonVersion: ${JSON.stringify(version)},
      apiVersion: 3,
      supportedApiVersions: [1, 2, 3],
    }));
  } else {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  }
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => server.close(() => process.exit(0)), 500);
});
server.listen(socketPath);
setTimeout(() => server.close(() => process.exit(0)), 5000);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
    'utf8'
  );
  chmodSync(binary, 0o755);

  try {
    await run(binary);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pure version-gate unit tests — always run, no daemon required. These lock the
// daemon-version compat check (`/v1/hello` → daemonVersion) that turns "daemon
// too old" into a typed error instead of a mid-operation contract surprise.
// ────────────────────────────────────────────────────────────────────────────
describe('assertRelayfileVersion', () => {
  it('accepts the minimum version and anything newer', () => {
    expect(() => assertRelayfileVersion(MIN_RELAYFILE_VERSION)).not.toThrow();
    expect(() => assertRelayfileVersion('0.99.0')).not.toThrow();
    expect(() => assertRelayfileVersion('1.0.0')).not.toThrow();
  });

  it('tolerates a leading v and surrounding words', () => {
    expect(() => assertRelayfileVersion('v0.99.0')).not.toThrow();
    expect(() => assertRelayfileVersion('relayfile 0.99.0 (abc1234)')).not.toThrow();
  });

  it('rejects a version older than the minimum with an actionable message', () => {
    expect(() => assertRelayfileVersion('0.10.15')).toThrow(
      new RegExp(
        `relayfile >= ${MIN_RELAYFILE_VERSION.replace(/\./g, '\\.')} is required; found "0\\.10\\.15"`
      )
    );
  });

  it('rejects unparseable version output', () => {
    expect(() => assertRelayfileVersion('not a version')).toThrow(/unparseable version/);
  });

  it('ships the API-v3 subscription-list method', () => {
    expect(typeof RelayfileControlPlaneClient.prototype.listWebhookSubscriptions).toBe('function');
  });
});

describe('relayfile control-plane hello negotiation', () => {
  it('discovers supported APIs without a version header, then uses v3 for normal requests', async () => {
    const requests: Array<{ method?: string; path?: string; version?: string }> = [];

    await withControlPlaneServer(
      (request, response) => {
        requests.push({
          method: request.method,
          path: request.url,
          version: request.headers['x-relayfile-api-version'] as string | undefined,
        });

        if (request.method === 'GET' && request.url === '/v1/hello') {
          writeJson(response, 200, {
            daemonVersion: '0.10.27',
            apiVersion: 3,
            supportedApiVersions: [1, 2, 3],
          });
          return;
        }
        if (request.method === 'GET' && request.url?.startsWith('/v1/integrations/provider-status?')) {
          writeJson(response, 200, { provider: 'slack', state: 'connected' });
          return;
        }
        writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      },
      async (socketPath) => {
        const bridge = defaultRelayfileBridge({ socketPath, autoStart: false });
        await bridge.ensureCompatible();
        await expect(bridge.isConnected('slack')).resolves.toBe(true);
      }
    );

    const helloRequests = requests.filter(({ path }) => path === '/v1/hello');
    expect(helloRequests.length).toBeGreaterThan(0);
    expect(helloRequests.every(({ method, version }) => method === 'GET' && version === undefined)).toBe(true);
    expect(requests.find(({ path }) => path?.startsWith('/v1/integrations/provider-status?'))?.version).toBe(
      '3'
    );
  });

  it('fails legacy v1 discovery once, before sending a versioned operation', async () => {
    const requests: Array<{ method?: string; path?: string; version?: string }> = [];

    await withControlPlaneServer(
      (request, response) => {
        requests.push({
          method: request.method,
          path: request.url,
          version: request.headers['x-relayfile-api-version'] as string | undefined,
        });
        writeJson(response, 200, {
          daemonVersion: '0.10.19',
          apiVersion: 1,
          supportedApiVersions: [1],
        });
      },
      async (socketPath) => {
        const bridge = defaultRelayfileBridge({ socketPath, autoStart: false });
        await expect(bridge.ensureCompatible()).rejects.toMatchObject({
          code: 'VERSION_INCOMPATIBLE',
          message: expect.stringMatching(
            /relayfile daemon 0\.10\.19.*speaks API v1.*supports v1.*requires API v3.*npm install -g relayfile@latest.*control-plane serve/s
          ),
        });
      }
    );

    expect(requests).toEqual([{ method: 'GET', path: '/v1/hello', version: undefined }]);
  });

  it('retries a transient missing socket while an auto-started daemon becomes ready', async () => {
    await withFakeRelayfileBinary('0.10.27', async (binary) => {
      const socketPath = join(tmpdir(), `rf-transient-${process.pid}-${++socketSequence}.sock`);
      rmSync(socketPath, { force: true });
      const bridge = defaultRelayfileBridge({
        socketPath,
        binary,
        autoStart: true,
        startTimeoutMs: 2000,
        requestTimeoutMs: 250,
      });

      await expect(bridge.ensureCompatible()).resolves.toBeUndefined();
      rmSync(socketPath, { force: true });
    });
  });

  it('replaces a stale v1 daemon only when the installed binary can serve v3', async () => {
    const legacyRequests: Array<{ method?: string; path?: string; version?: string }> = [];

    await withFakeRelayfileBinary('0.10.27', async (binary) => {
      await withControlPlaneServer(
        (request, response) => {
          legacyRequests.push({
            method: request.method,
            path: request.url,
            version: request.headers['x-relayfile-api-version'] as string | undefined,
          });
          writeJson(response, 200, {
            daemonVersion: '0.10.19',
            apiVersion: 1,
            supportedApiVersions: [1],
          });
        },
        async (socketPath) => {
          const bridge = defaultRelayfileBridge({
            socketPath,
            binary,
            autoStart: true,
            startTimeoutMs: 2000,
            requestTimeoutMs: 1000,
          });
          await expect(bridge.ensureCompatible()).resolves.toBeUndefined();
        }
      );
    });

    expect(legacyRequests).toEqual([{ method: 'GET', path: '/v1/hello', version: undefined }]);
  });

  it('leaves a stale v1 daemon in place when the installed binary is also too old', async () => {
    const legacyRequests: Array<{ method?: string; path?: string; version?: string }> = [];

    await withFakeRelayfileBinary('0.10.19', async (binary) => {
      await withControlPlaneServer(
        (request, response) => {
          legacyRequests.push({
            method: request.method,
            path: request.url,
            version: request.headers['x-relayfile-api-version'] as string | undefined,
          });
          writeJson(response, 200, {
            daemonVersion: '0.10.19',
            apiVersion: 1,
            supportedApiVersions: [1],
          });
        },
        async (socketPath) => {
          const bridge = defaultRelayfileBridge({
            socketPath,
            binary,
            autoStart: true,
            startTimeoutMs: 2000,
            requestTimeoutMs: 1000,
          });
          await expect(bridge.ensureCompatible()).rejects.toMatchObject({
            code: 'VERSION_INCOMPATIBLE',
            message: expect.stringContaining('Installed relayfile binary: 0.10.19'),
          });
        }
      );
    });

    expect(legacyRequests).toEqual([{ method: 'GET', path: '/v1/hello', version: undefined }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Real-daemon contract tests — boot `relayfile control-plane serve` and exercise
// the ACTUAL bridge over the unix socket (no spawn-per-op, no stdout parsing).
// This is the regression net for the socket contract: version handshake,
// native→glob resolve, and bind/list/unbind round-trip.
//
// Point RELAYFILE_BIN at the binary under test (CI: `go build -o relayfile
// ./cmd/relayfile-cli`). When unset these skip — opt-in, no PATH fallback.
// ────────────────────────────────────────────────────────────────────────────
const RELAYFILE_BIN = process.env.RELAYFILE_BIN?.trim();
const describeContract = RELAYFILE_BIN ? describe : describe.skip;

describeContract('relayfile bridge contract (real control-plane daemon)', () => {
  // Short socket path: macOS caps unix sun_path at ~104 bytes, so /tmp not the
  // (very long) test scratchpad.
  const sock = join(tmpdir(), `rf-contract-${process.pid}.sock`);
  let home: string;
  let daemon: ChildProcess;
  // autoStart:false — the daemon is already running, so the bridge never spawns.
  const bridge = defaultRelayfileBridge({ socketPath: sock, autoStart: false });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'relayfile-contract-'));
    daemon = spawn(RELAYFILE_BIN!, ['control-plane', 'serve', '--sock', sock], {
      env: { ...process.env, HOME: home, RELAYFILE_SOCK: sock },
      stdio: 'ignore',
    });
    // Wait for the socket to answer /v1/hello.
    const probe = new RelayfileControlPlaneClient({ socketPath: sock, autoStart: false });
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await probe.hello();
        return;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  afterAll(() => {
    daemon?.kill('SIGTERM');
    rmSync(sock, { force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('ensureCompatible() negotiates the daemon version over /v1/hello', async () => {
    await expect(bridge.ensureCompatible()).resolves.toBeUndefined();
  });

  it('resolveResourcePath() maps native -> glob and is idempotent', async () => {
    const fromNative = await bridge.resolveResourcePath('github', 'owner/repo');
    expect(fromNative.pathGlob).toBe('/github/repos/owner/repo/**');

    const fromGlob = await bridge.resolveResourcePath('github', '/github/repos/owner/repo/**');
    expect(fromGlob.pathGlob).toBe('/github/repos/owner/repo/**');
  });

  it('resolveResourcePath() surfaces a structured warning on wildcard fallback', async () => {
    const resolved = await bridge.resolveResourcePath('slack', '#general');
    expect(resolved.pathGlob.startsWith('/')).toBe(true);
    expect(resolved.warning).toBeTruthy();
  });

  it('bind -> listBindings -> unbind round-trips on the resolved glob', async () => {
    const { pathGlob } = await bridge.resolveResourcePath('github', 'acme/widgets');

    await bridge.bind({
      provider: 'github',
      resource: pathGlob,
      channel: 'general',
      webhookId: 'wh_contract',
      webhookToken: 'tok_contract',
      subscriptionId: 'sub_contract',
      webhookSubscriptionId: 'whsub_contract',
      webhookSubscriptionWorkspaceId: 'rw_contract_pin',
    });

    const afterBind = await bridge.listBindings();
    const binding = afterBind.find((b) => b.provider === 'github' && b.resource === pathGlob);
    expect(binding).toBeDefined();
    // Surfaced from relayfile's `pathGlob`, not the native spelling.
    expect(binding!.resource).toBe('/github/repos/acme/widgets/**');
    expect(binding!.channel).toBe('general');
    expect(binding!.webhookId).toBe('wh_contract');
    expect(binding!.subscriptionId).toBe('sub_contract');
    expect(binding!.webhookSubscriptionId).toBe('whsub_contract');
    // The published v0.10.21 client types the (id, workspace) pair, and the
    // daemon enforces it as an atomic pair.
    expect(binding!.webhookSubscriptionWorkspaceId).toBe('rw_contract_pin');

    await bridge.unbind('github', pathGlob);
    const afterUnbind = await bridge.listBindings();
    expect(afterUnbind.find((b) => b.resource === pathGlob)).toBeUndefined();
  });
});
