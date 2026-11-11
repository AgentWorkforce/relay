import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { RelayfileControlPlaneClient, RelayfileControlPlaneError } from '@relayfile/client';

import {
  RELAYFILE_DAEMON_STALLED,
  RecoveringControlPlane,
  isRelayfileControlPlaneTimeout,
} from './relayfile-stall-recovery.js';

const timeoutError = () =>
  new RelayfileControlPlaneError(
    'DAEMON_UNAVAILABLE',
    'relayfile control-plane request timed out after 30000ms (GET /v1/integrations/provider-status?provider=github)',
    undefined,
    true
  );

function fakeClients(...clients: unknown[]) {
  const queue = [...clients];
  return vi.fn(() => queue.shift() as RelayfileControlPlaneClient);
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
