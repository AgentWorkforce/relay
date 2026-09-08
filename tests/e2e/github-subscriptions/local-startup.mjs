#!/usr/bin/env node
// Real local HTTP/WebSocket/broker/process wiring; deliberately NOT a real AI/GitHub action proof.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessDriverClient } from '../../../packages/harness-driver/dist/index.js';
import { launchSubscriptionRecipient } from '../../../packages/cli/dist/cli/commands/integration-recipient.js';

const engineDir = process.env.RELAYCAST_ENGINE_DIR;
const binaryPath = process.env.BROKER_BINARY_PATH;
assert(engineDir && binaryPath, 'Set RELAYCAST_ENGINE_DIR and BROKER_BINARY_PATH to the candidate builds');
const { startServer } = await import(path.join(engineDir, 'packages/engine/dist/entrypoints/node.js'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const work = mkdtempSync(path.join(tmpdir(), 'ghsub-local-startup-'));
const report = {
  at: new Date().toISOString(),
  environment: 'isolated local SQLite + real broker + shell process fixtures',
  ready: false,
  checks: [],
};
const server = startServer({
  port: 0,
  dbPath: ':memory:',
  fileDir: path.join(work, 'files'),
  config: { environment: 'test', relayfileInboundSecret: 'local-fixture-only' },
});
if (!server.server.listening) await once(server.server, 'listening');
const baseUrl = `http://127.0.0.1:${server.server.address().port}`;
let key, client;
const request = async (route, method = 'GET', body) => {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `${method} ${route}: ${response.status}`);
  return (await response.json()).data;
};
try {
  key = (await request('/v1/workspaces', 'POST', { name: 'isolated-ghsub-startup' })).api_key;
  const isolatedEnv = Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => k.startsWith('RELAY_') || k.startsWith('AGENT_RELAY_'))
      .map((k) => [k, ''])
  );
  client = await HarnessDriverClient.spawn({
    binaryPath,
    cwd: work,
    workspaceKey: key,
    brokerName: 'isolated-ghsub-startup',
    binaryArgs: { persist: true, apiPort: 0 },
    channels: [],
    env: {
      ...isolatedEnv,
      RELAY_AGENT_TYPE: 'system',
      RELAY_AGENT_NAME: 'isolated-ghsub-startup',
      RELAY_BASE_URL: baseUrl,
      RELAYCAST_BASE_URL: baseUrl,
    },
    startupTimeoutMs: 30000,
  });
  client.connectEvents();
  process.chdir(work);
  const before = await request('/v1/webhooks');
  await assert.rejects(
    launchSubscriptionRecipient({
      name: 'invalid-cwd',
      cli: '/bin/false',
      provider: 'github',
      resource: '/github/repos/o/r/**',
      cwd: path.join(work, 'does-not-exist'),
      options: { workspaceKey: key, baseUrl },
    }),
    /Invalid recipient cwd/
  );
  assert.equal(
    (await client.listAgents()).some((w) => w.name === 'invalid-cwd'),
    false
  );
  assert.deepEqual(await request('/v1/webhooks'), before);
  report.checks.push({ name: 'invalid cwd fails before registration/resources', pass: true });

  await assert.rejects(
    launchSubscriptionRecipient({
      name: 'early-exit',
      cli: '/bin/false',
      provider: 'github',
      resource: '/github/repos/o/r/**',
      cwd: work,
      options: { workspaceKey: key, baseUrl },
    }),
    /failed startup|spawn|exit|Recipient/
  );
  assert.equal(
    (await client.listAgents()).some((w) => w.name === 'early-exit'),
    false
  );
  assert.deepEqual(await request('/v1/webhooks'), before);
  report.checks.push({ name: 'early process exit is terminal with no webhook resources', pass: true });

  // A native process fixture supplies a real PID without pretending that cat is an AI harness.
  const worker = await client.spawnCli({
    name: 'membership-process',
    cli: 'process-fixture',
    channels: ['proof-one', 'proof-two'],
    cwd: work,
    harnessConfig: {
      runtime: 'native',
      command: '/bin/cat',
      args: [],
      sessionId: 'local-membership-process',
    },
  });
  assert(worker.generation && worker.pid);
  assert.equal(
    (await client.listAgents()).find((w) => w.name === worker.name)?.generation,
    worker.generation
  );
  process.kill(worker.pid, 0);
  for (const name of ['proof-one', 'proof-two']) {
    const channel = await request(`/v1/channels/${name}`);
    assert(channel.members.some((m) => m.agent_name === 'membership-process'));
  }
  await assert.rejects(
    client.release('membership-process', 'stale cleanup must fail', '00000000-0000-0000-0000-000000000000'),
    /generation changed/
  );
  process.kill(worker.pid, 0);
  assert((await client.listAgents()).some((w) => w.name === 'membership-process'));
  await worker.release('owned local fixture cleanup');
  assert.equal(
    (await client.listAgents()).some((w) => w.name === 'membership-process'),
    false
  );
  report.checks.push({ name: 'real plural membership and generation-safe release', pass: true });
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  process.chdir(repo);
  if (client)
    await client.shutdown().catch((error) => {
      report.cleanupError = error.message;
      process.exitCode = 1;
    });
  await server.stop();
  rmSync(work, { recursive: true, force: true });
  const text = JSON.stringify(report, null, 2) + '\n';
  if (process.env.PROOF_OUTPUT) writeFileSync(process.env.PROOF_OUTPUT, text);
  console.log(text);
}
