import { type ChildProcess, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RELAYFILE_API_VERSION,
  RelayfileControlPlaneClient,
  RelayfileControlPlaneError,
  defaultRelayfileSocketPath,
} from './relayfile-client.js';

describe('defaultRelayfileSocketPath', () => {
  const saved = { sock: process.env.RELAYFILE_SOCK, xdg: process.env.XDG_RUNTIME_DIR };
  afterEach(() => {
    process.env.RELAYFILE_SOCK = saved.sock;
    process.env.XDG_RUNTIME_DIR = saved.xdg;
    if (saved.sock === undefined) delete process.env.RELAYFILE_SOCK;
    if (saved.xdg === undefined) delete process.env.XDG_RUNTIME_DIR;
  });

  it('prefers RELAYFILE_SOCK', () => {
    process.env.RELAYFILE_SOCK = '/run/custom.sock';
    expect(defaultRelayfileSocketPath()).toBe('/run/custom.sock');
  });

  it('falls back to XDG_RUNTIME_DIR/relayfile.sock', () => {
    delete process.env.RELAYFILE_SOCK;
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    expect(defaultRelayfileSocketPath()).toBe('/run/user/1000/relayfile.sock');
  });

  it('falls back to tmpdir', () => {
    delete process.env.RELAYFILE_SOCK;
    delete process.env.XDG_RUNTIME_DIR;
    expect(defaultRelayfileSocketPath()).toBe(join(tmpdir(), 'relayfile.sock'));
  });
});

describe('RelayfileControlPlaneClient lifecycle', () => {
  it('require-daemon mode (autoStart:false) fails fast with an actionable error', async () => {
    const client = new RelayfileControlPlaneClient({
      socketPath: join(tmpdir(), `rf-absent-${process.pid}.sock`),
      autoStart: false,
    });
    await expect(client.ensureReady()).rejects.toMatchObject({
      code: 'DAEMON_UNAVAILABLE',
    });
    await expect(client.ensureReady()).rejects.toThrow(/control-plane serve|not running/);
  });

  it('rejects a daemon whose supportedApiVersions excludes this client', async () => {
    const client = new RelayfileControlPlaneClient({ socketPath: '/nope.sock', autoStart: false });
    vi.spyOn(client, 'hello').mockResolvedValue({
      daemonVersion: '0.10.16',
      apiVersion: 2,
      supportedApiVersions: [2],
    });
    await expect(client.ensureReady()).rejects.toMatchObject({ code: 'VERSION_INCOMPATIBLE' });
  });

  it('rejects a daemon older than the minimum version', async () => {
    const client = new RelayfileControlPlaneClient({ socketPath: '/nope.sock', autoStart: false });
    vi.spyOn(client, 'hello').mockResolvedValue({
      daemonVersion: '0.10.15',
      apiVersion: RELAYFILE_API_VERSION,
      supportedApiVersions: [RELAYFILE_API_VERSION],
    });
    await expect(client.ensureReady()).rejects.toThrow(/0\.10\.16 is required/);
  });

  it('auto-start with a missing binary fails fast with DAEMON_UNAVAILABLE (no crash)', async () => {
    // spawn() reports a missing binary via an async 'error' (ENOENT) on the
    // child, not a throw — without the child 'error' listener this would be an
    // uncaught exception that crashes the CLI. It must reject cleanly instead.
    const client = new RelayfileControlPlaneClient({
      socketPath: join(tmpdir(), `rf-missing-bin-${process.pid}.sock`),
      binary: join(tmpdir(), 'definitely-not-a-relayfile-binary-xyz'),
      autoStart: true,
      startTimeoutMs: 3000,
    });
    await expect(client.ensureReady()).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
  }, 10000);

  it('does not cache a failed readiness probe (retries next call)', async () => {
    const client = new RelayfileControlPlaneClient({ socketPath: '/nope.sock', autoStart: false });
    const hello = vi
      .spyOn(client, 'hello')
      .mockRejectedValueOnce(new RelayfileControlPlaneError('DAEMON_UNAVAILABLE', 'down'))
      .mockResolvedValue({
        daemonVersion: '0.10.16',
        apiVersion: RELAYFILE_API_VERSION,
        supportedApiVersions: [RELAYFILE_API_VERSION],
      });
    await expect(client.ensureReady()).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
    await expect(client.ensureReady()).resolves.toBeUndefined();
    expect(hello).toHaveBeenCalledTimes(2);
  });
});

// Opt-in: proves the ONE remaining process launch (daemon lifecycle auto-start)
// actually boots a daemon and connects. Requires RELAYFILE_BIN.
const RELAYFILE_BIN = process.env.RELAYFILE_BIN?.trim();
const describeAutoStart = RELAYFILE_BIN ? describe : describe.skip;

describeAutoStart('RelayfileControlPlaneClient auto-start', () => {
  const sock = join(tmpdir(), `rf-autostart-${process.pid}.sock`);
  let strays: ChildProcess[] = [];

  beforeEach(() => {
    rmSync(sock, { force: true });
    strays = [];
  });
  afterEach(() => {
    // Kill any daemon the client auto-started (it detached/unref'd it).
    spawn('pkill', ['-f', `control-plane serve --sock ${sock}`], { stdio: 'ignore' });
    strays.forEach((c) => c.kill('SIGTERM'));
    rmSync(sock, { force: true });
  });

  it('auto-starts the daemon when the socket is absent, then negotiates', async () => {
    const client = new RelayfileControlPlaneClient({
      socketPath: sock,
      binary: RELAYFILE_BIN,
      autoStart: true,
      startTimeoutMs: 6000,
    });
    await expect(client.ensureReady()).resolves.toBeUndefined();
    const hello = await client.hello();
    expect(hello.supportedApiVersions).toContain(RELAYFILE_API_VERSION);
  });
});
