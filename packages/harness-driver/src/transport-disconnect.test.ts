import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('explicit events disconnect lets a real child exit when the peer never answers Close', async () => {
  // Compile the current source, not potentially stale dist. Keep the temporary
  // module under this package so its ws dependency resolves normally.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = mkdtempSync(path.join(here, '.disconnect-fixture-'));
  const compiled = path.join(fixture, 'transport.mjs');
  writeFileSync(
    compiled,
    ts.transpileModule(readFileSync(path.join(here, 'transport.ts'), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
  );

  const sockets = new Set<Duplex>();
  let upgrades = 0;
  let clientBytes = 0;
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    upgrades++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    // Deliberately do not decode or answer client frames, matching a broker
    // event peer that writes broadcasts/pings but never reads Close frames.
    socket.on('data', (data) => {
      clientBytes += data.length;
    });
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const event = Buffer.from(JSON.stringify({ kind: 'agent_spawned', name: 'observer-fixture' }));
    socket.write(Buffer.concat([Buffer.from([0x81, event.length]), event]));
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture port');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { BrokerTransport } from ${JSON.stringify(pathToFileURL(compiled).href)};
      const transport = new BrokerTransport({ baseUrl: 'http://127.0.0.1:${address.port}' });
      let received = 0;
      transport.onEvent(() => {
        received++;
        transport.disconnect();
        transport.disconnect(); // disposal remains idempotent
        console.log('disconnected');
      });
      process.on('beforeExit', () => console.log(JSON.stringify({
        received, connected: transport.connected,
        resources: process.getActiveResourcesInfo().filter(type => /Timeout|TCP/.test(type)),
      })));
      transport.connect();
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // Observe closure immediately, including failed spawn; do not attach a late
    // exit listener in cleanup. Only this owned child can be signalled.
    let closed = false;
    let spawnError: Error | undefined;
    let stdout = '';
    let stderr = '';
    child.on('error', (error) => {
      spawnError = error;
    });
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const closure = new Promise<void>((resolve) =>
      child.once('close', () => {
        closed = true;
        resolve();
      })
    );
    let deadlineExpired = false;
    const guard = setTimeout(() => {
      deadlineExpired = true;
      if (!closed && child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 3000);
    try {
      await closure;
      expect(spawnError).toBeUndefined();
      expect(stdout).toContain('disconnected');
      expect(deadlineExpired, `child retained the observer socket/timer: ${stdout} ${stderr}`).toBe(false);
      expect(child.killed).toBe(false);
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
      const state = JSON.parse(stdout.trim().split('\n').at(-1)!);
      expect(state).toEqual({ received: 1, connected: false, resources: [] });
      expect(upgrades).toBe(1); // explicit disconnect never reconnects
      expect(clientBytes).toBe(0); // observer disposal sends no application data
    } finally {
      clearTimeout(guard);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(fixture, { recursive: true, force: true });
  }
}, 8000);
