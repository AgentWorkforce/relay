import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
let bunAvailable = false;
try {
  execFileSync('bun', ['--version'], { stdio: 'pipe' });
  bunAvailable = true;
} catch {
  /* Optional native toolchain. */
}

// Exercise the real CLI bundle: a module-only or in-memory MCP test cannot
// detect two stdio servers started by the compiled CLI entrypoint.
describe.skipIf(!bunAvailable)('compiled CLI MCP single dispatch', () => {
  let directory: string;
  let binary: string;
  beforeAll(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-dispatch-'));
    if (process.env.RELAY_MCP_TEST_BINARY) {
      binary = path.resolve(process.env.RELAY_MCP_TEST_BINARY);
      return;
    }
    binary = path.join(directory, 'agent-relay');
    execFileSync(
      'bun',
      [
        'build',
        '--compile',
        '--minify',
        '--external',
        'better-sqlite3',
        '--external',
        'cpu-features',
        '--external',
        'node-pty',
        path.join(here, 'index.ts'),
        '--outfile',
        binary,
      ],
      { stdio: 'pipe' }
    );
  }, 60000);
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  for (const mode of ['201', 'accepted-503', 'accepted-disconnect'] as const) {
    it(`dispatches once and preserves accepted identity through ${mode}`, async () => {
      const posts: Array<{ key: string | undefined; body: string }> = [];
      const accepted = new Map<string, string>();
      const statuses: Array<number | 'disconnect'> = [];
      const frames: Array<{ id?: number; result?: { content?: Array<{ text: string }> } }> = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (req.method === 'POST' && req.url === '/v1/channels/local-owned/messages') {
          const key = req.headers['idempotency-key'] as string | undefined;
          posts.push({ key, body });
          const attempt = posts.length;
          const identity = key ?? `missing-key-${posts.length}`;
          if (!accepted.has(identity))
            accepted.set(identity, String(123456789000000000n + BigInt(accepted.size)));
          // Acceptance precedes the failed response. Retrying must recover this
          // identity, rather than merely producing the same visible message text.
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (attempt === 1 && mode === 'accepted-disconnect') {
            statuses.push('disconnect');
            res.destroy();
            return;
          }
          if (attempt === 1 && mode === 'accepted-503') {
            statuses.push(503);
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'local test' } }));
            return;
          }
          const status = attempt === 1 ? 201 : 200;
          statuses.push(status);
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              data: {
                id: accepted.get(identity),
                channel_id: '123456789000000099',
                agent_id: '123456789000000098',
                agent_name: 'local-owned',
                text: 'one call',
                created_at: new Date().toISOString(),
              },
            })
          );
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/v1/inbox')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data: { dms: [], mentions: [], unreads: [] } }));
          return;
        }
        res.writeHead(403);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local capture port');
      const child = spawn(binary, ['mcp'], {
        cwd: directory,
        env: {
          PATH: '/usr/bin:/bin',
          RELAY_BASE_URL: `http://127.0.0.1:${address.port}`,
          RELAY_WORKSPACE_KEY: 'rk_live_local_test',
          RELAY_AGENT_TOKEN: 'at_live_local_test',
          RELAY_AGENT_NAME: 'local-owned',
          RELAY_SKIP_BOOTSTRAP: '1',
          RELAY_STRICT_AGENT_NAME: '1',
          AGENT_RELAY_TELEMETRY_DISABLED: '1',
          DO_NOT_TRACK: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stderr.resume();
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            frames.push(JSON.parse(line));
          } catch {
            /* Only protocol frames count. */
          }
        }
      });
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 10000;
        while (!predicate()) {
          if (child.exitCode !== null || Date.now() > deadline)
            throw new Error('MCP response timeout or early exit');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
      try {
        send({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'dispatch-test', version: '1' },
          },
        });
        await until(() => frames.some((frame) => frame.id === 0));
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: { name: 'post_message', arguments: { channel: 'local-owned', text: 'one call' } },
        });
        await until(() => frames.some((frame) => frame.id === 42));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(frames.filter((frame) => frame.id === 0)).toHaveLength(1);
        const replies = frames.filter((frame) => frame.id === 42);
        expect(replies).toHaveLength(1);
        expect(posts).toHaveLength(mode === '201' ? 1 : 2);
        expect(posts[0].key).toBeTruthy();
        expect(new Set(posts.map((post) => post.key)).size).toBe(1);
        expect(new Set(posts.map((post) => post.body)).size).toBe(1);
        expect(accepted.size).toBe(1);
        expect(JSON.parse(replies[0].result!.content![0].text).id).toBe([...accepted.values()][0]);
        expect(statuses).toEqual(
          mode === '201' ? [201] : [mode === 'accepted-503' ? 503 : 'disconnect', 200]
        );
      } finally {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGTERM'), 1000);
        await exited;
        clearTimeout(timer);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 20000);
  }
});
