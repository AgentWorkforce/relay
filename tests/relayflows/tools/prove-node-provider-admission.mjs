/** Local compiled-broker/real-engine regression. Never contacts hosted services.
 * Usage: node <this-file> <broker-binary> <engine-serve.js> <evidence-directory>
 * This proves provider admission and delivery into the broker, not Nango/chief acceptance.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const [binary, engineBin, directory] = process.argv.slice(2).map(value => path.resolve(value));
assert(binary && engineBin && directory, 'broker binary, engine serve.js, and evidence directory are required');
await mkdir(directory, { recursive: false });
const state = path.join(directory, 'state');
await mkdir(state);
const logs = { engine: '', broker: '' };
const children = [];
const run = (label, file, args, options) => {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs[label] += data; });
  return child;
};
async function wait(check, label, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) {
      if (error.code !== 'ENOENT' && error.cause?.code !== 'ECONNREFUSED') throw error;
    }
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function request(origin, route, method = 'GET', body, token) {
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const value = text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null;
  return { status: response.status, value };
}
let report;
try {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  run('engine', process.execPath, [engineBin, '--port', String(port), '--db', path.join(directory, 'engine.sqlite'), '--env', 'test'],
    { cwd: directory, env: { PATH: process.env.PATH, HOME: directory } });
  await wait(() => fetch(origin + '/health').then(response => response.ok), 'local engine');
  const workspace = await request(origin, '/v1/workspaces', 'POST', { name: 'provider-admission-proof' });
  assert.equal(workspace.status, 201);
  const key = workspace.value.data.api_key;
  assert(key);
  const nodeId = `node_${randomUUID().replaceAll('-', '')}`;
  const node = await request(origin, '/v1/nodes', 'POST', { node_id: nodeId, name: 'provider-proof-node', kind: 'ws',
    role: 'broker', capabilities: [], max_agents: 8, tags: [], version: 'proof' }, key);
  assert.equal(node.status, 201);
  const apiKey = 'local-provider-proof';
  run('broker', binary, ['init', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', state], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory, TMPDIR: process.env.TMPDIR ?? '/tmp',
      RELAY_BASE_URL: origin, RELAYCAST_BASE_URL: origin, RELAY_API_KEY: key, RELAY_WORKSPACE_KEY: key,
      RELAY_NODE_ID: nodeId, RELAY_NODE_TOKEN: node.value.data.token, RELAY_BROKER_API_KEY: apiKey,
      RELAY_SKIP_TELEMETRY: '1' },
  });
  const apiOrigin = await wait(async () => {
    const connection = JSON.parse(await readFile(path.join(state, 'connection.json'), 'utf8'));
    const url = new URL(connection.url);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
    return url.origin;
  }, 'broker API address');
  const api = (route, method, body) => request(apiOrigin, route, method, body, apiKey);
  await wait(async () => (await api('/api/session')).status === 200, 'broker API ready');
  // A contract-unavailable response is proven unsent and may be attempted again;
  // no other failed registration is retried by this regression driver.
  const spawned = await wait(async () => {
    const response = await api('/api/spawn', 'POST', { name: 'provider-worker', cli: 'cat', transport: 'pty', channels: [] });
    if (JSON.stringify(response).includes('node_registration_contract_unavailable')) return false;
    assert.equal(response.status, 200, JSON.stringify(response));
    return response;
  }, 'fresh node admission');
  assert.equal(spawned.value.success, true);
  const identity = await request(origin, '/v1/agents/provider-worker', 'GET', undefined, key);
  assert.equal(identity.status, 200);
  const row = identity.value.data;
  await writeFile(path.join(directory, 'identity-private.json'), JSON.stringify(identity, null, 2), { mode: 0o600 });
  const inventory = await api('/api/fleet-inventory');
  await writeFile(path.join(directory, 'inventory-private.json'), JSON.stringify(inventory, null, 2), { mode: 0o600 });
  const duplicate = await api('/api/spawn', 'POST', { name: 'provider-worker', cli: 'cat', channels: [] });
  assert(duplicate.status >= 400);
  const held = await api('/api/spawned/provider-worker/delivery-mode', 'PUT', { mode: 'manual_flush' });
  assert.equal(held.status, 200, JSON.stringify(held));
  const sender = await request(origin, '/v1/agents', 'POST', { name: 'provider-sender', type: 'agent' }, key);
  assert.equal(sender.status, 201);
  const fleet = await request(origin, '/v1/actions/spawn/invoke', 'POST', { input: {
    name: 'fleet-provider-worker', cli: 'codex', channels: [], target_node: inventory.value.node_name,
    harnessConfig: { runtime: 'native', command: 'cat', args: [], sessionId: 'fleet-provider-session' },
  } }, sender.value.data.token);
  assert.equal(fleet.status, 201, JSON.stringify(fleet));
  const invocationId = fleet.value.data.invocation_id;
  await wait(async () => {
    const outcome = await request(origin, `/v1/actions/spawn/invocations/${invocationId}`, 'GET', undefined, key);
    if (outcome.value?.data?.status === 'failed') throw new Error('Fleet admission failed: ' + JSON.stringify(outcome.value.data.error));
    return outcome.value?.data?.status === 'completed';
  }, 'fleet node action admission');
  const marker = `provider-delivery-${randomUUID()}`;
  const dm = await request(origin, '/v1/dm', 'POST', { to: 'provider-worker', text: marker }, sender.value.data.token);
  assert(dm.status < 300);
  await wait(async () => JSON.stringify(await api('/api/spawned/provider-worker/pending')).includes(marker), 'real engine DM reaches exact broker recipient');
  const Database = createRequire(engineBin)('better-sqlite3');
  const database = new Database(path.join(directory, 'engine.sqlite'), { readonly: true });
  try {
    const stored = database.prepare('SELECT id, provider_name, origin_node_id FROM agents WHERE name = ?').get('provider-worker');
    assert.equal(stored.provider_name, 'broker');
    assert.equal(stored.origin_node_id, nodeId);
    const fleetStored = database.prepare('SELECT id, provider_name, origin_node_id FROM agents WHERE name = ?').get('fleet-provider-worker');
    assert.equal(fleetStored.provider_name, 'broker');
    assert.equal(fleetStored.origin_node_id, nodeId);
    assert.equal(database.prepare('SELECT count(*) AS count FROM channel_members WHERE agent_id = ?').get(fleetStored.id).count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM channel_members WHERE agent_id = ?').get(stored.id).count, 0);
    assert(JSON.stringify(inventory).includes(stored.id));
    const guarded = await request(origin, '/v1/agents/release', 'POST', { name: 'provider-worker', expected_token_hash: '0'.repeat(64) }, key);
    assert.equal(guarded.status, 409);
    assert.equal(database.prepare('SELECT id FROM agents WHERE name = ?').get('provider-worker').id, stored.id);
    const failed = await api('/api/spawn', 'POST', { name: 'failed-provider-worker', cli: 'cat', transport: 'pty', channels: [], cwd: path.join(directory, 'missing-cwd') });
    assert(failed.status >= 400);
    assert(JSON.stringify(failed).includes('cwd'));
    assert.equal(database.prepare('SELECT id FROM agents WHERE name = ?').get('failed-provider-worker'), undefined);
  } finally { database.close(); }
  report = { passed: true, acceptanceEvidence: false, brokerSha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    engineServeSha256: createHash('sha256').update(await readFile(engineBin)).digest('hex'),
    freshSpawn: true, fleetSpawn: true, duplicateRejected: true, providerAndOriginCorrect: true, isolatedChannels: true, guardedReleaseRejectedWrongHash: true, failedLaunchCleanedOwnedIdentity: true, brokerReceivedRealDm: true, identityId: row.id,
    note: 'Real engine and compiled broker with local disposable identities; no hosted or Nango proof.' };
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  for (const [label, text] of Object.entries(logs)) await writeFile(path.join(directory, `${label}-private.log`), text, { mode: 0o600 });
  if (report) await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
