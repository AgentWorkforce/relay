import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'vitest';

import { AgentRelayClient, type BrokerExitInfo } from '../client.js';

const STARTUP_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

function exitingBrokerSource(options: { exitAfterSession?: boolean; exitDelayMs?: number } = {}): string {
  const exitAfterSession = options.exitAfterSession ?? false;
  const exitDelayMs = options.exitDelayMs ?? 1_000;

  return [
    "const http = require('node:http');",
    'const server = http.createServer((req, res) => {',
    "  if (req.url === '/api/session') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    `    res.end(JSON.stringify({ broker_version: 'test', protocol_version: 1, workspace_key: 'wk_fake', mode: 'test', uptime_secs: 0 }), () => {`,
    `      if (${exitAfterSession}) setTimeout(() => process.exit(7), ${exitDelayMs});`,
    '    });',
    '    return;',
    '  }',
    "  if (req.url === '/api/session/renew' || req.url === '/api/shutdown') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    '    res.end(JSON.stringify({ ok: true }));',
    '    return;',
    '  }',
    "  res.writeHead(404, { 'content-type': 'application/json' });",
    "  res.end(JSON.stringify({ error: 'not found' }));",
    '});',
    "server.listen(0, '127.0.0.1', () => {",
    '  const address = server.address();',
    '  console.log(`[agent-relay] API listening on http://127.0.0.1:${address.port}`);',
    '  for (let index = 0; index < 45; index += 1) {',
    '    console.error(`stderr-${index}`);',
    '  }',
    `  if (!${exitAfterSession}) setTimeout(() => process.exit(7), ${exitDelayMs});`,
    '});',
    '',
  ].join('\n');
}

function waitForBrokerExit(client: AgentRelayClient): Promise<BrokerExitInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for broker exit notification'));
    }, 5_000);
    const unsubscribe = client.onBrokerExit((info) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(info);
    });
  });
}

test(
  'spawned clients notify subscribers when the broker child exits',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-relay-sdk-exit-'));

    try {
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, 'init'), exitingBrokerSource(), 'utf8');

      const client = await AgentRelayClient.spawn({
        binaryPath: process.execPath,
        cwd,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        requestTimeoutMs: 3_000,
      });
      const pid = client.brokerPid;

      assert.ok(pid, 'spawned client should expose broker pid before exit');
      const info = await waitForBrokerExit(client);

      assert.equal(info.code, 7);
      assert.equal(info.signal, null);
      assert.equal(info.pid, pid);
      assert.equal(info.recentStderr.length, 40);
      assert.equal(info.recentStderr[0], 'stderr-5');
      assert.equal(info.recentStderr.at(-1), 'stderr-44');
      assert.equal(client.brokerPid, undefined);

      const lateInfo = await waitForBrokerExit(client);
      assert.deepEqual(lateInfo, info);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS
);

test(
  'spawned clients replay broker exit when the child dies before consumers can subscribe',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-relay-sdk-early-exit-'));

    try {
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(cwd, 'init'),
        exitingBrokerSource({ exitAfterSession: true, exitDelayMs: 10 }),
        'utf8'
      );

      const client = await AgentRelayClient.spawn({
        binaryPath: process.execPath,
        cwd,
        startupTimeoutMs: STARTUP_TIMEOUT_MS,
        requestTimeoutMs: 3_000,
      });
      const info = await waitForBrokerExit(client);

      assert.equal(info.code, 7);
      assert.equal(info.signal, null);
      assert.equal(info.recentStderr.at(-1), 'stderr-44');
      assert.equal(client.brokerPid, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS
);

test('onBrokerExit is a no-op for clients that do not own a broker child process', async () => {
  const client = new AgentRelayClient({ baseUrl: 'http://127.0.0.1:1' });
  let called = false;

  const unsubscribe = client.onBrokerExit(() => {
    called = true;
  });
  unsubscribe();
  await sleep(0);

  assert.equal(called, false);
});
