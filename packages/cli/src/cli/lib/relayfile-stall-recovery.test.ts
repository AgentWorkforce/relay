import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RelayfileControlPlaneClient, RelayfileControlPlaneError } from '@relayfile/client';

import {
  RELAYFILE_DAEMON_STALLED,
  RESTART_WAIT_MS,
  RecoveringControlPlane,
  fileWriteGuard,
  isRelayfileControlPlaneTimeout,
  writeMarkerDir,
} from './relayfile-stall-recovery.js';

// Isolate the default write-marker directory (beside the default socket) from
// any real relayfile daemon on this machine.
const isolatedRuntime = mkdtempSync(join(tmpdir(), 'rf-stall-runtime-'));
const savedSock = process.env.RELAYFILE_SOCK;
beforeAll(() => {
  process.env.RELAYFILE_SOCK = join(isolatedRuntime, 'relayfile.sock');
});
afterAll(() => {
  if (savedSock === undefined) delete process.env.RELAYFILE_SOCK;
  else process.env.RELAYFILE_SOCK = savedSock;
  rmSync(isolatedRuntime, { recursive: true, force: true });
});

const resetError = () =>
  new RelayfileControlPlaneError('DAEMON_UNAVAILABLE', 'socket hang up', undefined, true);

/** A deferred promise, for driving interleavings by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const timeoutError = () =>
  new RelayfileControlPlaneError(
    'DAEMON_UNAVAILABLE',
    'relayfile control-plane request timed out after 30000ms (GET /v1/integrations/provider-status?provider=github)',
    undefined,
    true
  );

/**
 * Hand out fake clients in order. Each gets a ready daemon and a runnable
 * binary unless the test overrides them; identity is preserved so tests can
 * tell the stalled client from its replacement.
 */
function fakeClients(...clients: Array<Record<string, unknown>>) {
  for (const client of clients) {
    client.ensureReady ??= async () => {};
    client.installedBinaryVersion ??= async () => '0.10.79';
  }
  const queue = [...clients];
  return vi.fn(() => queue.shift() as unknown as RelayfileControlPlaneClient);
}

describe('isRelayfileControlPlaneTimeout', () => {
  it('matches only client-side request timeouts', () => {
    expect(isRelayfileControlPlaneTimeout(timeoutError())).toBe(true);
    expect(
      isRelayfileControlPlaneTimeout(
        new RelayfileControlPlaneError(
          'DAEMON_UNAVAILABLE',
          'relayfile control-plane is not running at /x (ENOENT)'
        )
      )
    ).toBe(false);
    expect(isRelayfileControlPlaneTimeout(new Error('timed out after 5ms'))).toBe(false);
  });
});

describe('RecoveringControlPlane', () => {
  it('does not restart the daemon when the request succeeds', async () => {
    const stopDaemon = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients({ id: 1 }),
      stopDaemon,
    });
    await expect(cp.run('hello', async () => 'ok')).resolves.toBe('ok');
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('restarts a stalled daemon and retries once on a fresh client', async () => {
    const first = { id: 'stalled' };
    const second = { id: 'fresh' };
    const createClient = fakeClients(first, second);
    const stopDaemon = vi.fn(async () => {});
    const warn = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient,
      stopDaemon,
      warn,
    });

    const seen: unknown[] = [];
    const result = await cp.run('provider-status', async (client) => {
      seen.push(client);
      if (client === (first as unknown)) throw timeoutError();
      return 'ready';
    });

    expect(result).toBe('ready');
    expect(seen).toEqual([first, second]);
    expect(stopDaemon).toHaveBeenCalledWith(first);
    expect(cp.client).toBe(second);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not answer provider-status'));
  });

  it('reports DAEMON_STALLED when the retry also times out', async () => {
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients({}, {}),
      stopDaemon: async () => {},
      warn: () => {},
    });
    await expect(
      cp.run('writeback-secret', async () => {
        throw timeoutError();
      })
    ).rejects.toMatchObject({
      code: RELAYFILE_DAEMON_STALLED,
      message: expect.stringMatching(/stalled on writeback-secret.*also stalled after an automatic restart/s),
    });
  });

  it('reports DAEMON_STALLED with a manual remedy when the daemon cannot be stopped', async () => {
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients({}),
      stopDaemon: async () => {
        throw new Error('lsof not found');
      },
    });
    await expect(
      cp.run('provider-status', async () => {
        throw timeoutError();
      })
    ).rejects.toMatchObject({
      code: RELAYFILE_DAEMON_STALLED,
      message: expect.stringContaining('Could not restart it automatically (lsof not found)'),
    });
  });

  it('leaves a working daemon running when no replacement can be started', async () => {
    const stopDaemon = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients({ installedBinaryVersion: async () => undefined }),
      stopDaemon,
    });
    await expect(
      cp.run('provider-status', async () => {
        throw timeoutError();
      })
    ).rejects.toMatchObject({
      code: RELAYFILE_DAEMON_STALLED,
      message: expect.stringContaining('Left the daemon running because no replacement could be started'),
    });
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('reports DAEMON_STALLED when the replacement daemon fails to start', async () => {
    const unavailable = new RelayfileControlPlaneError(
      'DAEMON_UNAVAILABLE',
      'failed to start relayfile control-plane (spawn relayfile ENOENT)'
    );
    const stalled = {};
    const replacement = {
      ensureReady: async () => {
        throw unavailable;
      },
    };
    const op = vi.fn(async (client: unknown) => {
      if (client === stalled) throw timeoutError();
      return 'unreachable';
    });
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients(stalled, replacement),
      stopDaemon: async () => {},
      warn: () => {},
    });
    await expect(cp.run('writeback-secret', op)).rejects.toMatchObject({
      code: RELAYFILE_DAEMON_STALLED,
      message: expect.stringMatching(/Stopped the hung daemon, but its replacement did not start.*ENOENT/s),
    });
    // The endpoint is never retried against a daemon that is not up.
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('never kills the daemon when auto-start is disabled', async () => {
    const stopDaemon = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: false },
      createClient: fakeClients({}),
      stopDaemon,
    });
    await expect(
      cp.run('provider-status', async () => {
        throw timeoutError();
      })
    ).rejects.toMatchObject({ code: RELAYFILE_DAEMON_STALLED });
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('passes non-timeout errors through untouched', async () => {
    const stopDaemon = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients({}),
      stopDaemon,
    });
    const notFound = new RelayfileControlPlaneError('NOT_FOUND', 'nope', 404);
    await expect(
      cp.run('provider-status', async () => {
        throw notFound;
      })
    ).rejects.toBe(notFound);
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('shares one restart across concurrent reads that stall on the same daemon', async () => {
    const stalled = { id: 'stalled' };
    const fresh = { id: 'fresh' };
    const createClient = fakeClients(stalled, fresh);
    let releaseStop!: () => void;
    const stopDaemon = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        })
    );
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient,
      stopDaemon,
      warn: () => {},
    });
    const read = (workspace: string) =>
      cp.run('webhook-subscriptions', async (client) => {
        if (client === (stalled as unknown)) throw timeoutError();
        return `${workspace}:ok`;
      });

    // Promise.all fan-out, as the per-workspace subscription listing does.
    const pending = Promise.all([read('ws_a'), read('ws_b'), read('ws_c')]);
    await vi.waitFor(() => expect(stopDaemon).toHaveBeenCalled());
    releaseStop();

    await expect(pending).resolves.toEqual(['ws_a:ok', 'ws_b:ok', 'ws_c:ok']);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('does not stop a replacement daemon when a late caller stalled on the old one', async () => {
    const stalled = { id: 'stalled' };
    const fresh = { id: 'fresh' };
    const stopDaemon = vi.fn(async () => {});
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients(stalled, fresh),
      stopDaemon,
      warn: () => {},
    });
    let failLate!: () => void;
    const late = cp.run('provider-status', async (client) => {
      if (client === (stalled as unknown)) {
        // Still waiting on the old daemon while another caller recovers.
        await new Promise<void>((resolve) => {
          failLate = resolve;
        });
        throw timeoutError();
      }
      return 'late:ok';
    });
    await expect(
      cp.run('hello', async (client) => {
        if (client === (stalled as unknown)) throw timeoutError();
        return 'early:ok';
      })
    ).resolves.toBe('early:ok');
    failLate();

    await expect(late).resolves.toBe('late:ok');
    expect(stopDaemon).toHaveBeenCalledTimes(1);
  });

  it('retries a read reset by a shared recovery that is still in flight (staggered reads)', async () => {
    const stalled = { id: 'stalled' };
    const fresh = { id: 'fresh' };
    const stopping = deferred();
    const stopDaemon = vi.fn(() => stopping.promise);
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients(stalled, fresh),
      stopDaemon,
      warn: () => {},
    });
    // Read A is mid-request on the old daemon when read B times out.
    const inFlightA = deferred<string>();
    const a = cp.run('webhook-subscriptions', (client) =>
      client === (stalled as unknown) ? inFlightA.promise : Promise.resolve('a:fresh')
    );
    const b = cp.run('webhook-subscriptions', async (client) => {
      if (client === (stalled as unknown)) throw timeoutError();
      return 'b:fresh';
    });
    await vi.waitFor(() => expect(stopDaemon).toHaveBeenCalled());
    // Stopping the daemon resets A's connection: a connection loss, not a timeout.
    inFlightA.reject(resetError());
    stopping.resolve();

    await expect(Promise.all([a, b])).resolves.toEqual(['a:fresh', 'b:fresh']);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
  });

  it('retries a read reset after the shared recovery already finished', async () => {
    const stalled = { id: 'stalled' };
    const fresh = { id: 'fresh' };
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients(stalled, fresh),
      stopDaemon: async () => {},
      warn: () => {},
    });
    const inFlightA = deferred<string>();
    const a = cp.run('list-bindings', (client) =>
      client === (stalled as unknown) ? inFlightA.promise : Promise.resolve('a:fresh')
    );
    await expect(
      cp.run('hello', async (client) => {
        if (client === (stalled as unknown)) throw timeoutError();
        return 'b:fresh';
      })
    ).resolves.toBe('b:fresh');
    inFlightA.reject(resetError());
    await expect(a).resolves.toBe('a:fresh');
  });

  it('does not retry a connection loss when no recovery is involved', async () => {
    const reset = resetError();
    const op = vi.fn(async () => {
      throw reset;
    });
    const stopDaemon = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients({}),
      stopDaemon,
    });
    await expect(cp.run('provider-status', op)).rejects.toBe(reset);
    expect(op).toHaveBeenCalledTimes(1);
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('never retries a write and never recovers on its timeout', async () => {
    const timedOut = timeoutError();
    const op = vi.fn(async () => {
      throw timedOut;
    });
    const stopDaemon = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients({}),
      stopDaemon,
    });
    await expect(cp.mutate('bind', op)).rejects.toBe(timedOut);
    expect(op).toHaveBeenCalledTimes(1);
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('leaves the daemon running while this process has a write in flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const stopDaemon = vi.fn();
      const cp = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients({}),
        stopDaemon,
        writeGuard: fileWriteGuard(dir),
      });
      const bindInFlight = deferred<string>();
      const write = cp.mutate('bind', () => bindInFlight.promise);

      await expect(
        cp.run('provider-status', async () => {
          throw timeoutError();
        })
      ).rejects.toMatchObject({
        code: RELAYFILE_DAEMON_STALLED,
        message: expect.stringMatching(/another relay command has a write in flight on it \(pid \d+ bind\)/),
      });
      expect(stopDaemon).not.toHaveBeenCalled();

      bindInFlight.resolve('bound');
      await expect(write).resolves.toBe('bound');
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the daemon running while another live process has a write in flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    // Stands in for a second agent-relay invocation in the middle of an unbind.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(dir, `${other.pid}-00000000-0000-4000-8000-000000000000`), 'unbind');
      const stopDaemon = vi.fn();
      const cp = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients({}),
        stopDaemon,
        writeGuard: fileWriteGuard(dir),
      });
      await expect(
        cp.run('provider-status', async () => {
          throw timeoutError();
        })
      ).rejects.toMatchObject({
        code: RELAYFILE_DAEMON_STALLED,
        message: expect.stringContaining(`pid ${other.pid} unbind`),
      });
      expect(stopDaemon).not.toHaveBeenCalled();
    } finally {
      other.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores and removes write markers left by dead processes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const dead = spawnSync(process.execPath, ['-e', '0']).pid;
      mkdirSync(dir, { recursive: true });
      const marker = join(dir, `${dead}-00000000-0000-4000-8000-000000000000`);
      writeFileSync(marker, 'bind');
      expect(fileWriteGuard(dir).activeWrites()).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a write issued during recovery to the replacement daemon', async () => {
    const stalled = { id: 'stalled' };
    const fresh = { id: 'fresh' };
    const stopping = deferred();
    const stopDaemon = vi.fn(() => stopping.promise);
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients(stalled, fresh),
      stopDaemon,
      writeGuard: fileWriteGuard(mkdtempSync(join(isolatedRuntime, 'w-'))),
      warn: () => {},
    });
    const read = cp.run('hello', async (client) => {
      if (client === (stalled as unknown)) throw timeoutError();
      return 'ok';
    });
    await vi.waitFor(() => expect(stopDaemon).toHaveBeenCalled());
    const seen: unknown[] = [];
    const write = cp.mutate('bind', async (client) => {
      seen.push(client);
      return 'bound';
    });
    stopping.resolve();
    await expect(Promise.all([read, write])).resolves.toEqual(['ok', 'bound']);
    expect(seen).toEqual([fresh]);
  });

  it('holds a write that starts after a restart took the lock until the restart finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const restarter = fileWriteGuard(dir);
      const claim = await restarter.acquireRestart(Date.now());
      expect(claim.kind).toBe('acquired');

      // Another relay process begins a bind after the lock was taken.
      let begun = false;
      const writer = fileWriteGuard(dir)
        .begin('bind')
        .then((end) => {
          begun = true;
          return end;
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(begun).toBe(false);
      // Its marker is withdrawn while it waits, so it never blocks the restart.
      expect(restarter.activeWrites()).toEqual([]);

      if (claim.kind === 'acquired') claim.release();
      const end = await writer;
      expect(begun).toBe(true);
      expect(restarter.activeWrites()).toHaveLength(1);
      end();
      expect(restarter.activeWrites()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not send another process write until the replacement daemon is ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const stalled = { id: 'stalled' };
      const fresh = { id: 'fresh' };
      const stopping = deferred();
      const stopDaemon = vi.fn(() => stopping.promise);
      const recovering = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients(stalled, fresh),
        stopDaemon,
        writeGuard: fileWriteGuard(dir),
        warn: () => {},
      });
      // A second agent-relay process sharing the same daemon.
      const otherProcess = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients({ id: 'other' }),
        writeGuard: fileWriteGuard(dir),
      });

      const read = recovering.run('hello', async (client) => {
        if (client === (stalled as unknown)) throw timeoutError();
        return 'ok';
      });
      await vi.waitFor(() => expect(stopDaemon).toHaveBeenCalled());

      const bind = vi.fn(async () => 'bound');
      const write = otherProcess.mutate('bind', bind);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bind).not.toHaveBeenCalled();

      stopping.resolve();
      await expect(Promise.all([read, write])).resolves.toEqual(['ok', 'bound']);
      expect(bind).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits for another process restart and uses its replacement instead of stopping it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      mkdirSync(dir, { recursive: true });
      // Another live process's claim on the restart.
      const lock = join(dir, `.restart-${other.pid}-00000000-0000-4000-8000-000000000000`);
      writeFileSync(lock, '');
      const stalled = { id: 'stalled' };
      const fresh = { id: 'fresh' };
      const stopDaemon = vi.fn();
      const cp = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients(stalled, fresh),
        stopDaemon,
        writeGuard: fileWriteGuard(dir),
        warn: () => {},
      });
      const read = cp.run('provider-status', async (client) => {
        if (client === (stalled as unknown)) throw timeoutError();
        return 'ready';
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The other process finishes its restart: it records the stop, then
      // gives up its claim (in that order, as the real guard does).
      writeFileSync(
        join(dir, `.stopped-${Date.now()}-${other.pid}-00000000-0000-4000-8000-000000000001`),
        ''
      );
      rmSync(lock, { force: true });

      await expect(read).resolves.toBe('ready');
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(cp.client).toBe(fresh);
    } finally {
      other.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports DAEMON_STALLED when another process restart does not finish in time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `.restart-${other.pid}-00000000-0000-4000-8000-000000000000`), '');
      const stopDaemon = vi.fn();
      const cp = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients({}),
        stopDaemon,
        writeGuard: fileWriteGuard(dir, 300),
        restartWaitMs: 300,
      });
      await expect(
        cp.run('provider-status', async () => {
          throw timeoutError();
        })
      ).rejects.toMatchObject({
        code: RELAYFILE_DAEMON_STALLED,
        message: expect.stringContaining('another relay command is restarting the daemon'),
      });
      await expect(cp.mutate('bind', async () => 'bound')).rejects.toMatchObject({
        code: RELAYFILE_DAEMON_STALLED,
        message: expect.stringContaining('bind was not sent'),
      });
      expect(stopDaemon).not.toHaveBeenCalled();
    } finally {
      other.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores and removes a restart claim abandoned by a dead process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      mkdirSync(dir, { recursive: true });
      const dead = spawnSync(process.execPath, ['-e', '0']).pid;
      const abandoned = join(dir, `.restart-${dead}-00000000-0000-4000-8000-000000000000`);
      writeFileSync(abandoned, '');
      const claim = await fileWriteGuard(dir).acquireRestart(Date.now());
      expect(claim.kind).toBe('acquired');
      expect(existsSync(abandoned)).toBe(false);
      if (claim.kind === 'acquired') claim.release();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never lets two processes hold the restart at once, even when they claim simultaneously', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-race-'));
    const log = join(dir, 'holders.log');
    const child = join(dir, 'claimant.mjs');
    // Each claimant loads the real module, waits for a shared start instant
    // so the claims genuinely collide, then repeatedly takes the restart,
    // holds it briefly, and releases it.
    writeFileSync(
      child,
      [
        "import { appendFileSync } from 'node:fs';",
        'const [jitiUrl, modulePath, guardDir, startAt, logPath] = process.argv.slice(2);',
        'const { createJiti } = await import(jitiUrl);',
        'const { fileWriteGuard } = await createJiti(modulePath).import(modulePath);',
        'const guard = fileWriteGuard(guardDir);',
        'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
        'while (Date.now() < Number(startAt)) {}',
        'let held = 0;',
        'for (let round = 0; round < 20 && held < 2; round += 1) {',
        '  const claim = await guard.acquireRestart(0);',
        "  if (claim.kind !== 'acquired') { await guard.waitForRestart(10000); continue; }",
        '  held += 1;',
        '  const t0 = performance.timeOrigin + performance.now();',
        '  await sleep(30);',
        '  const t1 = performance.timeOrigin + performance.now();',
        '  appendFileSync(logPath, `${process.pid} ${t0} ${t1}\\n`);',
        '  claim.release();',
        '}',
      ].join('\n'),
      'utf8'
    );
    const modulePath = fileURLToPath(new URL('./relayfile-stall-recovery.ts', import.meta.url));
    const jitiUrl = import.meta.resolve('jiti');
    const startAt = Date.now() + 4000;
    const claimants = Array.from(
      { length: 6 },
      () =>
        new Promise<number>((resolve) => {
          const proc = spawn(
            process.execPath,
            [child, jitiUrl, modulePath, join(dir, 'guard'), String(startAt), log],
            { stdio: 'inherit' }
          );
          proc.on('exit', (code) => resolve(code ?? 1));
        })
    );
    try {
      expect(await Promise.all(claimants)).toEqual([0, 0, 0, 0, 0, 0]);
      const holds = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split(' ').map(Number) as [number, number, number])
        .sort((a, b) => a[1] - b[1]);
      expect(holds.length).toBeGreaterThanOrEqual(6);
      for (let i = 1; i < holds.length; i += 1) {
        // Each hold starts only after the previous one ended.
        expect(holds[i]![1]).toBeGreaterThanOrEqual(holds[i - 1]![2]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not restart a replacement when the observed restart finishes during backoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const sentAt = Date.now();
      // Process A holds the restart of the daemon B's request hung on.
      const a = await fileWriteGuard(dir).acquireRestart(sentAt);
      expect(a.kind).toBe('acquired');
      // B sees A's claim, withdraws, and backs off...
      const b = fileWriteGuard(dir).acquireRestart(sentAt);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // ...while A stops the old daemon and finishes.
      if (a.kind !== 'acquired') throw new Error('unreachable');
      a.markStopped();
      a.release();
      // B must use A's replacement, not claim the restart and stop it.
      await expect(b).resolves.toEqual({ kind: 'restarted' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not restart a replacement made after the stalled request was sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const sentAt = Date.now();
      const a = await fileWriteGuard(dir).acquireRestart(sentAt);
      if (a.kind !== 'acquired') throw new Error('expected to acquire');
      a.markStopped();
      a.release();
      // B only looks after A is completely done: no claim is left to see.
      await expect(fileWriteGuard(dir).acquireRestart(sentAt)).resolves.toEqual({ kind: 'restarted' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still restarts a replacement that itself hung after an earlier restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const a = await fileWriteGuard(dir).acquireRestart(Date.now());
      if (a.kind !== 'acquired') throw new Error('expected to acquire');
      a.markStopped();
      a.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // B's request went to the replacement (sent after the stop) and hung.
      const b = await fileWriteGuard(dir).acquireRestart(Date.now());
      expect(b.kind).toBe('acquired');
      if (b.kind === 'acquired') b.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times a reserved stop record from the stop, not the reservation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const a = await fileWriteGuard(dir).acquireRestart(Date.now());
      if (a.kind !== 'acquired') throw new Error('expected to acquire');
      a.prepareStop();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // B's request reached the old daemon after A reserved but before A stopped it.
      const sentAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
      a.markStopped();
      a.release();
      expect(readdirSync(dir).filter((n) => n.startsWith('.stopping-'))).toEqual([]);
      await expect(fileWriteGuard(dir).acquireRestart(sentAt)).resolves.toEqual({ kind: 'restarted' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat a reservation whose stop failed as a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const sentAt = Date.now();
      const a = await fileWriteGuard(dir).acquireRestart(sentAt);
      if (a.kind !== 'acquired') throw new Error('expected to acquire');
      a.prepareStop();
      a.release(); // the stop failed: nothing was replaced
      expect(readdirSync(dir).filter((n) => n.startsWith('.stopping-'))).toEqual([]);
      const b = await fileWriteGuard(dir).acquireRestart(sentAt);
      expect(b.kind).toBe('acquired');
      if (b.kind === 'acquired') b.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the daemon running when its stop cannot be recorded', async () => {
    const stalled = { id: 'stalled' };
    const stopDaemon = vi.fn(async () => {});
    const release = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients(stalled, { id: 'fresh' }),
      stopDaemon,
      writeGuard: {
        begin: async () => () => {},
        activeWrites: () => [],
        acquireRestart: async () => ({
          kind: 'acquired',
          prepareStop: () => {
            throw new Error('ENOSPC: no space left on device');
          },
          markStopped: () => {},
          stillHeld: () => true,
          release,
        }),
        waitForRestart: async () => true,
      },
      warn: () => {},
    });
    const read = cp.run('provider-status', async () => {
      throw timeoutError();
    });

    await expect(read).rejects.toThrow(/could not be recorded \(ENOSPC/);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(cp.client).toBe(stalled);
  });

  it('retries on another process replacement without stopping it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const stalled = { id: 'stalled' };
      const fresh = { id: 'fresh' };
      const stopDaemon = vi.fn();
      const cp = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients(stalled, fresh),
        stopDaemon,
        writeGuard: fileWriteGuard(dir),
        warn: () => {},
      });
      // Process A is mid-restart when B's read times out.
      const other = await fileWriteGuard(dir).acquireRestart(0);
      if (other.kind !== 'acquired') throw new Error('expected to acquire');
      const read = cp.run('provider-status', async (client) => {
        if (client === (stalled as unknown)) throw timeoutError();
        return 'ready';
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      other.markStopped();
      other.release();

      await expect(read).resolves.toBe('ready');
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(cp.client).toBe(fresh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes over when the other process gave up without stopping the daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const stalled = { id: 'stalled' };
      const fresh = { id: 'fresh' };
      const stopDaemon = vi.fn(async () => {});
      const cp = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients(stalled, fresh),
        stopDaemon,
        writeGuard: fileWriteGuard(dir),
        warn: () => {},
      });
      const other = await fileWriteGuard(dir).acquireRestart(0);
      if (other.kind !== 'acquired') throw new Error('expected to acquire');
      const read = cp.run('provider-status', async (client) => {
        if (client === (stalled as unknown)) throw timeoutError();
        return 'ready';
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      other.release(); // abandoned (e.g. preflight failed): no stop record

      await expect(read).resolves.toBe('ready');
      expect(stopDaemon).toHaveBeenCalledTimes(1);
      expect(stopDaemon).toHaveBeenCalledWith(stalled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a second process use the first process restart instead of stopping its replacement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      // Two agent-relay processes whose reads hung on the same daemon.
      const stalledA = { id: 'stalled-a' };
      const stalledB = { id: 'stalled-b' };
      const stoppingA = deferred();
      const stopA = vi.fn(() => stoppingA.promise);
      const stopB = vi.fn(async () => {});
      const a = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients(stalledA, { id: 'fresh-a' }),
        stopDaemon: stopA,
        writeGuard: fileWriteGuard(dir),
        warn: () => {},
      });
      const b = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients(stalledB, { id: 'fresh-b' }),
        stopDaemon: stopB,
        writeGuard: fileWriteGuard(dir),
        warn: () => {},
      });
      const readB = b.run('provider-status', async (client) => {
        if (client === (stalledB as unknown)) {
          // B's request is already on the wire when A starts its restart.
          await vi.waitFor(() => expect(stopA).toHaveBeenCalled());
          throw timeoutError();
        }
        return 'b:ready';
      });
      const readA = a.run('provider-status', async (client) => {
        if (client === (stalledA as unknown)) throw timeoutError();
        return 'a:ready';
      });
      await vi.waitFor(() => expect(stopA).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 200)); // B waits on A's claim
      stoppingA.resolve();

      await expect(Promise.all([readA, readB])).resolves.toEqual(['a:ready', 'b:ready']);
      expect(stopA).toHaveBeenCalledTimes(1);
      // B must not stop the replacement A just started.
      expect(stopB).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a live restarter claim held past its lifetime by refreshing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const timings = { claimMaxAgeMs: 150, claimHeartbeatMs: 30 };
      const a = await fileWriteGuard(dir, RESTART_WAIT_MS, timings).acquireRestart(Date.now());
      if (a.kind !== 'acquired') throw new Error('expected to acquire');
      // A long restart: well past the claim lifetime.
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(a.stillHeld()).toBe(true);
      // Another process must still see the restart as held.
      await expect(fileWriteGuard(dir, RESTART_WAIT_MS, timings).acquireRestart(Date.now())).resolves.toEqual(
        {
          kind: 'held',
        }
      );
      a.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fences a restarter whose claim expired while it was paused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      // The heartbeat never fires in time: the owner is effectively paused.
      const paused = { claimMaxAgeMs: 100, claimHeartbeatMs: 60_000 };
      const a = await fileWriteGuard(dir, RESTART_WAIT_MS, paused).acquireRestart(Date.now());
      if (a.kind !== 'acquired') throw new Error('expected to acquire');
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Another process expires the claim and takes the restart.
      const b = await fileWriteGuard(dir, RESTART_WAIT_MS, paused).acquireRestart(Date.now());
      expect(b.kind).toBe('acquired');
      // The paused owner learns it no longer holds the restart.
      expect(a.stillHeld()).toBe(false);
      if (b.kind === 'acquired') b.release();
      a.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not stop the daemon once its restart claim has expired', async () => {
    const stalled = { id: 'stalled' };
    const stopDaemon = vi.fn(async () => {});
    const release = vi.fn();
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient: fakeClients(stalled, { id: 'fresh' }),
      stopDaemon,
      writeGuard: {
        begin: async () => () => {},
        activeWrites: () => [],
        acquireRestart: async () => ({
          kind: 'acquired',
          prepareStop: () => {},
          markStopped: () => {},
          stillHeld: () => false, // expired while this process was paused
          release,
        }),
        waitForRestart: async () => true,
      },
      warn: () => {},
    });
    await expect(
      cp.run('provider-status', async () => {
        throw timeoutError();
      })
    ).rejects.toMatchObject({
      code: RELAYFILE_DAEMON_STALLED,
      message: expect.stringContaining('paused past its restart claim'),
    });
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(cp.client).toBe(stalled);
  });

  it('does not start a replacement when the claim expired during the stop', async () => {
    const stalled = { id: 'stalled' };
    const createClient = fakeClients(stalled, { id: 'fresh' });
    let held = true;
    const stopDaemon = vi.fn(async () => {
      held = false; // paused mid-stop; another process now owns the restart
    });
    const cp = new RecoveringControlPlane({
      clientOptions: { autoStart: true },
      createClient,
      stopDaemon,
      writeGuard: {
        begin: async () => () => {},
        activeWrites: () => [],
        acquireRestart: async () => ({
          kind: 'acquired',
          prepareStop: () => {},
          markStopped: () => {},
          stillHeld: () => held,
          release: () => {},
        }),
        waitForRestart: async () => true,
      },
      warn: () => {},
    });
    await expect(
      cp.run('provider-status', async () => {
        throw timeoutError();
      })
    ).rejects.toMatchObject({ code: RELAYFILE_DAEMON_STALLED });
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    // No replacement client was started by the fenced owner.
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('reuses another process replacement without needing a local relayfile binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-writes-'));
    try {
      const stalled = { id: 'stalled' };
      const fresh = { id: 'fresh' };
      const canStartReplacement = vi.fn(async () => false);
      const stopDaemon = vi.fn();
      const cp = new RecoveringControlPlane({
        clientOptions: { autoStart: true },
        createClient: fakeClients(stalled, fresh),
        stopDaemon,
        canStartReplacement,
        writeGuard: fileWriteGuard(dir),
        warn: () => {},
      });
      const read = cp.run('provider-status', async (client) => {
        if (client === (stalled as unknown)) {
          // Another process replaces the daemon while this request hangs.
          const other = await fileWriteGuard(dir).acquireRestart(0);
          if (other.kind !== 'acquired') throw new Error('expected to acquire');
          other.markStopped();
          other.release();
          throw timeoutError();
        }
        return 'ready';
      });
      await expect(read).resolves.toBe('ready');
      expect(canStartReplacement).not.toHaveBeenCalled();
      expect(stopDaemon).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('places write markers beside the daemon socket', () => {
    expect(writeMarkerDir('/run/user/1000/relayfile.sock')).toBe('/run/user/1000/relayfile.sock.writes');
  });

  it.skipIf(process.platform === 'win32')(
    'kills and replaces a real hung daemon process with the default stopper',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rf-stall-bin-'));
      const binary = join(dir, 'relayfile');
      const socketPath = join(dir, 'cp.sock');
      // The first daemon answers one provider-status and then hangs; the
      // auto-started replacement answers everything.
      writeFileSync(
        binary,
        `#!/usr/bin/env node
const { existsSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join, dirname } = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('0.10.79'); process.exit(0); }
const sock = args[args.indexOf('--sock') + 1];
rmSync(sock, { force: true });
// Only the first daemon process wedges; its replacement stays healthy.
const marker = join(dirname(sock), 'first-daemon-started');
const wedges = !existsSync(marker);
writeFileSync(marker, String(process.pid));
let served = 0;
const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer((req, res) => {
  if (req.url === '/v1/hello') return json(res, { daemonVersion: '0.10.79', apiVersion: 3, supportedApiVersions: [1, 2, 3] });
  served += 1;
  if (wedges && served > 1) return; // hang
  json(res, { provider: 'github', status: 'ready' });
});
server.listen(sock);
process.on('SIGTERM', () => { rmSync(sock, { force: true }); process.exit(0); });
setTimeout(() => { rmSync(sock, { force: true }); process.exit(0); }, 15000).unref();
`,
        'utf8'
      );
      chmodSync(binary, 0o755);

      try {
        const cp = new RecoveringControlPlane({
          clientOptions: { socketPath, binary, autoStart: true, startTimeoutMs: 3000, requestTimeoutMs: 300 },
          warn: () => {},
        });
        const status = (c: RelayfileControlPlaneClient) => c.providerStatus('github');
        await expect(cp.run('provider-status', status)).resolves.toMatchObject({ status: 'ready' });
        // The same daemon now hangs; concurrent reads must share one real restart.
        await expect(
          Promise.all([cp.run('provider-status', status), cp.run('provider-status', status)])
        ).resolves.toEqual([
          expect.objectContaining({ status: 'ready' }),
          expect.objectContaining({ status: 'ready' }),
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000
  );

  it.skipIf(process.platform === 'win32')(
    'recovers a real socket daemon that hangs after serving its first request (#1952)',
    async () => {
      const socketPath = join(tmpdir(), `rf-stall-${process.pid}.sock`);
      rmSync(socketPath, { force: true });
      let served = 0;
      let wedged = true;
      const hung: ServerResponse[] = [];
      const json = (res: ServerResponse, body: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const handler: RequestListener = (req, res) => {
        if (req.url === '/v1/hello') {
          json(res, { daemonVersion: '0.10.79', apiVersion: 3, supportedApiVersions: [1, 2, 3] });
          return;
        }
        served += 1;
        // Mirrors the field report: the first request on a fresh daemon
        // succeeds; later ones on the same daemon never get a response.
        if (wedged && served > 1) {
          hung.push(res);
          return;
        }
        json(res, { provider: 'github', status: 'ready' });
      };
      const server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      try {
        const cp = new RecoveringControlPlane({
          clientOptions: { socketPath, autoStart: true, requestTimeoutMs: 200 },
          // The "restart": the replacement daemon is healthy.
          canStartReplacement: async () => true,
          stopDaemon: async () => {
            wedged = false;
          },
          warn: () => {},
        });
        const status = (c: RelayfileControlPlaneClient) => c.providerStatus('github');
        await expect(cp.run('provider-status', status)).resolves.toMatchObject({ status: 'ready' });
        await expect(cp.run('provider-status', status)).resolves.toMatchObject({ status: 'ready' });
        expect(hung).toHaveLength(1);
      } finally {
        for (const res of hung) res.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(socketPath, { force: true });
      }
    },
    10_000
  );
});
