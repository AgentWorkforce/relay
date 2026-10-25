#!/usr/bin/env node
// Node 22+: run against an explicitly chosen Relaycast origin. Creates and
// deletes a throwaway workspace; never reads desktop state or credentials.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.argv[2]?.replace(/\/+$/, '');
assert(base, 'Usage: node scripts/test-hosted-machine-address.mjs https://cast.agentrelay.com');
const failures = [];
async function request(path, token, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 204) return;
  const result = await response.json();
  assert(response.ok && result.ok, `${path}: ${response.status} ${JSON.stringify(result.error)}`);
  return result.data;
}
async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function check(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
  if (!condition) failures.push(label);
}
const workspace = await request('/v1/workspaces', null, {
  name: `desktop-address-smoke-${Date.now()}`, expires_in_seconds: 3600,
});
const key = workspace.api_key;
assert(key && workspace.workspace_id, 'Workspace response lacks id/key');
try {
  const sender = await request('/v1/agents', key, { name: 'address-sender' });
  for (const legacy of [false, true]) {
    const name = legacy ? 'legacy-session' : 'fresh-session';
    const prefix = legacy ? 'test-macbook-pro-local' : 'test-macbook-pro';
    const agent = await request('/v1/agents', key, {
      name, ...(!legacy ? { direct_machine_prefix: prefix } : {}),
    });
    const machine = `${prefix}-${agent.id}`;
    const address = `${name}@${machine}`;
    if (!legacy) check(agent.address === address, `${name}: registration returns ${address}`);
    const node = await request('/v1/agent/node-token', agent.token, {});
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/node/ws?token=${encodeURIComponent(node.token)}`);
    const frames = [];
    socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
    // Retain errors as diagnostics without printing token-bearing URLs.
    let socketFailed = false;
    socket.addEventListener('error', () => { socketFailed = true; });
    try {
      await until(() => socket.readyState === WebSocket.OPEN || socketFailed, 'socket open');
      assert(!socketFailed, 'WebSocket connection failed');
      socket.send(JSON.stringify({
        v: 1, id: 'register-test', type: 'node.register', node_id: node.node_id,
        name: node.node_name, machine_id: machine, capabilities: [], max_agents: 1,
        tags: ['implicit', 'direct', 'sdk'], version: 'relay-desktop/address-smoke', resume_cursor: null,
      }));
      await until(() => frames.some(frame => frame.id === 'register-test'), 'register reply');
      const reply = frames.find(frame => frame.id === 'register-test');
      check(reply.ok === true && reply.data?.machine_id === machine, `${name}: push publishes machine_id`);
      const roster = await request('/v1/agents', key);
      check(roster.find(entry => entry.id === agent.id)?.address === address, `${name}: roster agrees`);
      for (const recipient of [address, `${name}@direct`]) {
        const text = `address-smoke-${recipient}-${Date.now()}`;
        try {
          await request('/v1/dm', sender.token, { address: recipient, text });
          await until(() => frames.some(frame => frame.type === 'deliver' && JSON.stringify(frame).includes(text)), `delivery to ${recipient}`);
          check(true, `delivered ${recipient}`);
        } catch (error) {
          check(false, `${recipient}: ${error.message}`);
        }
      }
    } finally {
      socket.close();
    }
  }
} finally {
  await request(`/v1/workspaces/${workspace.workspace_id}`, key, null, 'DELETE');
  console.log('Deleted throwaway workspace');
}
assert.equal(failures.length, 0, `${failures.length} hosted machine-address checks failed`);
