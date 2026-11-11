import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
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
