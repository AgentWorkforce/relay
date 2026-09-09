import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runStatusCommand } from './broker-lifecycle.js';
import type { CoreDependencies } from '../commands/core.js';

describe('status with an unresponsive broker API', () => {
  it.each(['/api/status', '/api/session'])(
    'returns within the CLI smoke deadline when %s never responds',
    async (stalledPath) => {
      const requests = new Set<string>();
      const server = createServer((req, res) => {
        requests.add(req.url ?? '');
        if (req.url === stalledPath) return;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ agent_count: 0, pending_delivery_count: 0 }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address() as { port: number };
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-status-timeout-'));
      fs.writeFileSync(
        path.join(root, 'connection.json'),
        JSON.stringify({
          url: `http://127.0.0.1:${address.port}`,
          api_key: 'owned-test',
          pid: process.pid,
          port: address.port,
        })
      );
      const log = vi.fn();
      const deps = {
        fs,
        getProjectPaths: () => ({ dataDir: root, projectRoot: root }),
        now: Date.now,
        killProcess: process.kill.bind(process),
        log,
        warn: vi.fn(),
        exit: (code: number) => {
          throw new Error(`unexpected exit ${code}`);
        },
      } as unknown as CoreDependencies;
      try {
        const started = Date.now();
        await runStatusCommand(deps);
        expect(requests.has(stalledPath)).toBe(true);
        expect(log).toHaveBeenCalledWith('Status: RUNNING');
        expect(Date.now() - started).toBeLessThan(5000);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    6000
  );
});
