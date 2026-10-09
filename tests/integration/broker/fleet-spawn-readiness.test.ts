/** Real broker/PTY, loopback engine, deterministic Claude/Codex stubs; no live credentials. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { RelaycastMessagingClient } from '@agent-relay/sdk';
import { WebSocketServer, type WebSocket } from 'ws';

import { checkPrerequisites, resolveBinaryPath } from './utils/broker-harness.js';

for (const scenario of [
  { cli: 'claude', size: 0, explicit: false },
  { cli: 'claude', size: 400, explicit: false },
  { cli: 'claude', size: 8192, explicit: false },
  { cli: 'codex', size: 400, explicit: false },
  { cli: 'codex', size: 8192, explicit: false },
  { cli: 'claude', size: 8192, explicit: true },
  { cli: 'codex', size: 8192, explicit: true },
]) {
  const { cli, size, explicit } = scenario;
  test(
    `targeted ${cli} spawn preserves a ${size}-byte initial turn and confirms readiness${explicit ? ' with explicit PTY config' : ''}`,
    { timeout: 130_000 },
    async (t: TestContext) => {
      // Skip rather than fail when the broker has not been built, matching every
      // sibling suite here.
      const missing = checkPrerequisites();
      if (missing) {
        t.skip(missing);
        return;
      }
      const binary = resolveBinaryPath();
      const directory = await mkdtemp(path.join(tmpdir(), 'fleet-ready-'));
      const bin = path.join(directory, 'bin');
      await mkdir(bin);
      const turnFile = path.join(directory, 'turn.json');
      const prefix = '--Implement issue #34 exactly; preserve spaces  and punctuation.\n';
      const suffix = size === 400 ? '\nEND\t  ' : '\nEND é🙂\t  ';
      const task = size ? prefix + 'x'.repeat(size - Buffer.byteLength(prefix + suffix)) + suffix : undefined;
      if (task) assert.equal(Buffer.byteLength(task), size);
      await writeFile(
        path.join(bin, cli),
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('app-server')) process.exit(1);
if (args.includes('--version')) { console.log('${cli} 1.0.0'); process.exit(0); }
const separator = args.lastIndexOf('--');
const turns = separator >= 0 ? args.slice(separator + 1) : [];
let input = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', chunk => {
  input += chunk.toString();
  fs.writeFileSync(${JSON.stringify(turnFile)}, JSON.stringify({ turns, input }));
});
// The TUI drops input while loading. The native startup prompt is retained.
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(turnFile)}, JSON.stringify({ turns, input }));
  const screen = turns.length
    ? (${JSON.stringify(cli)} === 'codex' ? 'Working (1s • esc to interrupt)' : '✻ Thinking… (esc to interrupt)')
    : '->pty:ready';
  process.stdout.write('\\x1b[2J\\x1b[H' + screen);
}, 300);
setInterval(() => {}, 1000);
`,
        { mode: 0o755 }
      );
      const receipts = new Map<string, Record<string, unknown>>();
      let nodeSocket: WebSocket | undefined;
      let registrations = 0;
      const server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        response.setHeader('content-type', 'application/json');
        if (
          request.method === 'GET' &&
          (request.url === '/v1/agent' || request.url?.startsWith('/v1/agents/'))
        ) {
          response.end(
            JSON.stringify({
              ok: true,
              data: {
                id: 'worker-1',
                name: 'Probe',
                type: 'agent',
                workspace_id: 'fixture-workspace',
                status: 'online',
                channels: ['general', 'engineering'].map((name) => ({
                  id: `channel-${name}`,
                  name,
                  role: 'member',
                  joined_at: '2026-01-01T00:00:00Z',
                })),
                metadata: {},
              },
            })
          );
          return;
        }
        if (request.url?.endsWith('/members')) {
          response.end(
            JSON.stringify({
              ok: true,
              data: [
                {
                  agent_id: 'worker-1',
                  agent_name: 'Probe',
                  role: 'member',
                  joined_at: '2026-01-01T00:00:00Z',
                },
              ],
            })
          );
          return;
        }
        response.end(
          JSON.stringify({
            ok: true,
            data:
              request.url === '/v1/agents'
                ? {
                    id: 'fixture-broker',
                    workspace_id: 'fixture-workspace',
                    name: body.name,
                    token: 'at_fixture',
                    status: 'online',
                    created_at: '2026-01-01T00:00:00Z',
                  }
                : {
                    id: 'channel-fixture',
                    name: body.name ?? 'general',
                    workspace_id: 'fixture-workspace',
                    created_at: '2026-01-01T00:00:00Z',
                    created_by: 'fixture-broker',
                    is_archived: false,
                    topic: null,
                    members: [],
                    member_count: 1,
                  },
          })
        );
      });
      const wss = new WebSocketServer({ server });
      wss.on('connection', (socket, request) => {
        const isNode = request.url?.startsWith('/v1/node/ws');
        socket.on('message', (raw) => {
          const frame = JSON.parse(raw.toString());
          if (isNode && frame.type === 'inventory.sync') nodeSocket = socket;
          if (frame.type === 'action.result')
            receipts.set(frame.invocation_id, {
              invocation_id: frame.invocation_id,
              status: frame.error ? 'failed' : 'completed',
              output: frame.output,
              error: frame.error,
            });
          if (
            ['node.register', 'inventory.sync', 'agent.register', 'agent.deregister'].includes(frame.type)
          ) {
            if (frame.type === 'agent.register') registrations++;
            socket.send(
              JSON.stringify({
                v: 1,
                type: 'reply',
                id: frame.id,
                ok: true,
                data:
                  frame.type === 'agent.register'
                    ? {
                        agent_id: `worker-${registrations}`,
                        token: 'at_worker_fixture',
                        name: frame.name,
                        delivery_ack_seq: 0,
                      }
                    : {},
              })
            );
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const broker = spawn(
        binary,
        [
          'init',
          '--instance-name',
          'ready-node',
          '--workspace-key',
          'rk_fixture',
          '--state-dir',
          directory,
          '--api-port',
          '0',
          '--channels',
          '',
        ],
        {
          cwd: directory,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: directory,
            TMPDIR: directory,
            RELAYCAST_BASE_URL: baseUrl,
            RELAY_BASE_URL: baseUrl,
            RELAY_BROKER_API_KEY: 'br_fixture',
            RELAY_NODE_ID: 'node-ready',
            RELAY_NODE_TOKEN: 'nt_fixture',
            AGENT_RELAY_BROKER_LOG: 'stderr',
            AGENT_RELAY_TELEMETRY_DISABLED: '1',
            AGENT_RELAY_NO_DEBUG_FILES: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let logs = '';
      let spawnError: Error | undefined;
      broker.on('error', (error) => {
        spawnError = error;
      });
      broker.stdout.on('data', (chunk) => {
        logs = (logs + chunk).slice(-16000);
        if (process.env.FLEET_TEST_DEBUG) process.stderr.write(chunk);
      });
      broker.stderr.on('data', (chunk) => {
        logs = (logs + chunk).slice(-16000);
        if (process.env.FLEET_TEST_DEBUG) process.stderr.write(chunk);
      });
      try {
        const deadline = Date.now() + 10_000;
        while (!nodeSocket && Date.now() < deadline && !spawnError && broker.exitCode === null) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ifError(spawnError);
        assert(nodeSocket, `broker did not connect: ${logs}`);
        const node = {
          id: 'node-ready',
          name: 'ready-node',
          status: 'online',
          live: true,
          handlers_live: true,
          capabilities: [{ name: `spawn:${cli}`, kind: 'spawn' }],
        };
        let invocations = 0;
        const client = new RelaycastMessagingClient({
          relaycast: { nodes: { list: async () => [node], get: async () => node } } as never,
          agentClient: {
            actions: {
              invoke: async (_name: string, input: Record<string, unknown>) => {
                const id = `inv-${++invocations}`;
                nodeSocket!.send(
                  JSON.stringify({ v: 1, type: 'action.invoke', invocation_id: id, action: 'spawn', input })
                );
                return { invocation_id: id, status: 'invoked', handler_node_id: node.id };
              },
              getInvocation: async (_name: string, id: string) =>
                receipts.get(id) ?? { invocation_id: id, status: 'invoked' },
            },
          } as never,
        });
        const result = await client.placement.spawn({
          capability: `spawn:${cli}`,
          node: node.name,
          confirm: true,
          input: {
            name: 'Probe',
            cli,
            ...(task ? { task } : {}),
            ...(explicit ? { harnessConfig: { runtime: 'pty', command: path.join(bin, cli) } } : {}),
          },
        });
        assert.equal(result.placement.state, 'ready', logs);
        // Readiness must complete while the first task is still working, and
        // no duplicate initial turn may arrive over the PTY after that ACK.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const submitted = JSON.parse(await readFile(turnFile, 'utf8'));
        assert.deepEqual(submitted.turns, task ? [task] : []);
        assert.equal(submitted.input, '', 'startup task must never be typed through the PTY');
        assert.equal(invocations, 1);
        assert.equal(registrations, 1);
        assert.deepEqual(result.confirmation?.output, { spawned: true, ready: true, name: 'Probe' });
      } catch (error) {
        throw new Error(`${String(error)}\nBroker output:\n${logs}`, { cause: error });
      } finally {
        if (broker.exitCode === null && !spawnError) {
          const exited = new Promise((resolve) => broker.once('exit', resolve));
          broker.kill('SIGTERM');
          const timer = setTimeout(() => broker.kill('SIGKILL'), 2000);
          await exited;
          clearTimeout(timer);
        }
        for (const socket of wss.clients) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
}
