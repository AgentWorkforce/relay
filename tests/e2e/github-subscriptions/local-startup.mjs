#!/usr/bin/env node
// Real local HTTP/WebSocket/broker/process wiring; deliberately NOT a real AI/GitHub action proof.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Command } from 'commander';
import { registerIntegrationCommands } from '../../../packages/cli/dist/cli/commands/integration.js';
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
let key, client, actionToken;
const request = async (route, method = 'GET', body) => {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${route.startsWith('/v1/actions/') ? actionToken : key}` } : {}),
    },
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
  const bindingMutations = [];
  // Only the provider control port is a fixture; use the real command, SDK, engine and broker.
  const failSubscribe = async (name, cwd) => {
    const errors = [];
    const exits = [];
    let journal = [];
    const program = new Command();
    program.exitOverride();
    const forbidden = async (...args) => {
      bindingMutations.push(args);
      throw new Error('startup must precede provider mutation');
    };
    registerIntegrationCommands(program, {
      resolveLocalRelayOptions: async () => ({ workspaceKey: key, baseUrl }),
      isInteractive: () => false,
      log: () => {},
      error: (error) => errors.push(String(error)),
      exit: (code) => exits.push(code),
      cleanupJournal: {
        list: async () => journal,
        update: async (fn) => {
          journal = await fn(journal);
        },
      },
      relayfile: {
        ensureCompatible: async () => {},
        isConnected: async () => true,
        resolveResourcePath: async (_provider, resource) => ({ pathGlob: resource }),
        listBindings: async () => [],
        bind: forbidden,
        unbind: forbidden,
        createWebhookSubscription: forbidden,
        deleteWebhookSubscription: forbidden,
        resolveWritebackBinding: forbidden,
        listWebhookSubscriptions: async () => ({ subscriptions: [] }),
        connect: forbidden,
      },
    });
    await program.parseAsync(
      [
        'integration',
        'subscribe',
        'github',
        '--resource',
        '/github/repos/o/r/**',
        '--to',
        `@${name}`,
        '--spawn',
        '/bin/false',
        '--cwd',
        cwd,
        '--base-url',
        baseUrl,
        '--no-input',
      ],
      { from: 'user' }
    );
    assert.deepEqual(exits, [1]);
    assert.deepEqual(bindingMutations, []);
    assert.deepEqual(await request('/v1/webhooks'), before);
    assert.deepEqual(await request('/v1/subscriptions'), []);
    assert.equal(
      (await client.listAgents()).some((w) => w.name === name),
      false
    );
    return errors.join('\n');
  };
  assert.match(
    await failSubscribe('invalid-cwd', path.join(work, 'does-not-exist')),
    /Invalid recipient cwd/
  );
  report.checks.push({
    name: 'real subscribe command: invalid cwd before any subscription, webhook or binding',
    pass: true,
  });
  const earlyError = await failSubscribe('early-exit', work);
  assert.match(
    earlyError,
    /^agent 'early-exit' process exited during startup \(exit status: 1\); see worker log /
  );
  const earlyIdentity = (await request('/v1/agents')).find((a) => a.name === 'early-exit');
  assert(
    !earlyIdentity || earlyIdentity.status === 'released',
    'failed process identity cleanup must be confirmed'
  );
  report.checks.push({
    name: 'real subscribe command: early harness exit is terminal with zero resources and confirmed identity cleanup',
    pass: true,
  });

  // Exit well after the broker's startup stability window but before native
  // readiness. Reaping must retain immutable ownership for guarded cleanup.
  const delayed = await client.spawnCli({
    name: 'delayed-pre-ready',
    cli: 'process-fixture',
    channels: [],
    cwd: work,
    harnessConfig: {
      runtime: 'native',
      command: '/bin/sh',
      args: ['-c', 'sleep 2; exit 7'],
      sessionId: 'delayed-pre-ready',
    },
  });
  const delayedReady = await delayed.waitForReady(15_000);
  assert.equal(delayedReady.reason, 'exited');
  await assert.rejects(
    client.release(delayed.name, 'wrong generation', '00000000-0000-0000-0000-000000000000', true),
    /generation changed/
  );
  await delayed.release('delayed startup failed', { deleteIdentity: true });
  await delayed.release('idempotent retry after confirmed cleanup', { deleteIdentity: true });
  assert(!(await request('/v1/agents')).some((agent) => agent.name === delayed.name));
  const retry = await client.spawnCli({
    name: delayed.name,
    cli: 'process-fixture',
    channels: [],
    cwd: work,
    harnessConfig: { runtime: 'native', command: '/bin/cat', args: [], sessionId: 'delayed-pre-ready-retry' },
  });
  assert.notEqual(retry.generation, delayed.generation);
  await assert.rejects(
    delayed.release('stale retry cleanup', { deleteIdentity: true }),
    /generation changed/
  );
  process.kill(retry.pid, 0);
  await retry.release('owned retry cleanup', { deleteIdentity: true });
  assert.deepEqual(await request('/v1/webhooks'), before);
  assert.deepEqual(await request('/v1/subscriptions'), []);
  assert.deepEqual(bindingMutations, []);
  report.checks.push({
    name: 'delayed pre-ready exit cleanup, same-name retry and stale-generation rejection',
    pass: true,
  });

  const incumbent = await request('/v1/agents', 'POST', { name: 'incumbent-fixture' });
  const incumbentChannel = await request('/v1/agents/incumbent-fixture/subscription-channel', 'POST');
  const incumbentError = await failSubscribe('incumbent-fixture', work);
  assert.match(incumbentError, /already exists|name.*held|already registered/i);
  assert.equal((await request('/v1/agents/incumbent-fixture')).id, incumbent.id);
  assert(
    (await request(`/v1/channels/${incumbentChannel.name}`)).members.some(
      (m) => m.agent_name === 'incumbent-fixture'
    )
  );
  const incumbentRead = await fetch(`${baseUrl}/v1/channels/${incumbentChannel.name}`, {
    headers: { authorization: `Bearer ${incumbent.token}` },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(incumbentRead.status, 200, 'failed new spawn must preserve incumbent credential');
  report.checks.push({
    name: 'existing remote identity collision preserves identity, token and membership with zero new resources',
    pass: true,
  });

  const unrelated = await request('/v1/agents', 'POST', { name: 'unmapped-identity' });
  await assert.rejects(
    client.release('unmapped-identity', 'stale absent cleanup', 'stale-generation'),
    /generation changed|absent/
  );
  assert.equal((await request('/v1/agents/unmapped-identity')).id, unrelated.id);
  const isolated = await client.spawnCli({
    name: 'empty-channels-process',
    cli: 'process-fixture',
    channels: [],
    cwd: work,
    harnessConfig: { runtime: 'native', command: '/bin/cat', args: [], sessionId: 'empty-channels-process' },
  });
  assert.deepEqual(isolated.channels, [], 'broker must confirm effective empty channels');
  assert.deepEqual(
    (await request(`/v1/agents/${isolated.name}`)).channels,
    [],
    'live agent membership must be empty; cached channel metadata is not isolation evidence'
  );
  await isolated.release('owned isolated fixture cleanup', { deleteIdentity: true });
  report.checks.push({
    name: 'explicit empty channels remain isolated; absent-generation cleanup cannot release another identity',
    pass: true,
  });

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
  assert.deepEqual(worker.channels, ['proof-one', 'proof-two']);
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
  await worker.release('owned local fixture cleanup', { deleteIdentity: true });
  assert.equal(
    (await client.listAgents()).some((w) => w.name === 'membership-process'),
    false
  );
  report.checks.push({ name: 'real plural membership and generation-safe release', pass: true });
  actionToken = (
    await request('/v1/agents', 'POST', { name: 'owned-fleet-test-caller', auto_join_general: false })
  ).token;
  const pluralAction = await request('/v1/actions/spawn/invoke', 'POST', {
    input: {
      name: 'fleet-plural',
      cli: 'claude',
      task: '',
      channels: ['fleet-one', 'fleet-two'],
      worker_cwd: work,
      harnessConfig: { runtime: 'native', command: '/bin/cat', args: [], sessionId: 'fleet-plural' },
    },
  });
  let pluralResult;
  for (let attempt = 0; attempt < 100; attempt++) {
    pluralResult = await request(`/v1/actions/spawn/invocations/${pluralAction.invocation_id}`);
    if (['completed', 'failed'].includes(pluralResult.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(pluralResult.status, 'completed', JSON.stringify(pluralResult));
  assert.deepEqual(
    (await request('/v1/agents/fleet-plural')).channels.map((channel) => channel.name).sort(),
    ['fleet-one', 'fleet-two']
  );
  const pluralWorker = (await client.listAgents()).find((agent) => agent.name === 'fleet-plural');
  assert(pluralWorker?.generation);
  await client.release('fleet-plural', 'owned fleet plural fixture cleanup', pluralWorker.generation, true);
  report.checks.push({
    name: 'real fleet/action plural channels independently verified, no default general',
    pass: true,
  });

  for (const fixture of [
    { name: 'fleet-invalid-cwd', command: '/bin/cat', args: [], cwd: path.join(work, 'missing-fleet-cwd') },
    { name: 'fleet-immediate-exit', command: '/bin/false', args: [], cwd: work },
    { name: 'fleet-delayed-exit', command: '/bin/sh', args: ['-c', 'sleep 2; exit 7'], cwd: work },
    {
      name: 'fleet-membership-failure',
      command: '/bin/cat',
      args: [],
      cwd: work,
      channels: ['agent-events-forbidden'],
    },
  ]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const invocation = await request('/v1/actions/spawn/invoke', 'POST', {
        input: {
          name: fixture.name,
          cli: 'claude',
          task: '',
          channels: fixture.channels ?? [],
          worker_cwd: fixture.cwd,
          verify_ready: true,
          harnessConfig: {
            runtime: 'native',
            command: fixture.command,
            args: fixture.args,
            sessionId: `${fixture.name}-${attempt}`,
          },
        },
      });
      let result;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        result = await request(`/v1/actions/spawn/invocations/${invocation.invocation_id}`);
        if (['completed', 'failed'].includes(result.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(result.status, 'failed', JSON.stringify({ fixture: fixture.name, result }));
      assert(result.error, 'terminal failure must be actionable');
      assert(
        !(await request('/v1/agents')).some((agent) => agent.name === fixture.name),
        `failed fleet spawn retained identity ${fixture.name}: ${result.error}`
      );
      assert(!(await client.listAgents()).some((agent) => agent.name === fixture.name));
      assert.deepEqual(await request('/v1/webhooks'), before);
      assert.deepEqual(await request('/v1/subscriptions'), []);
      report.checks.push({
        name: `${fixture.name} attempt ${attempt + 1}: terminal failure, no identity/resources`,
        pass: true,
        error: result.error,
      });
    }
  }
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
