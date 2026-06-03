#!/usr/bin/env node
/**
 * v8 SDK API smoke test — exercises the redesigned public surface end-to-end
 * against a LIVE relay. This is NOT part of the vitest suite; it needs a real
 * Relaycast workspace, so it talks to the network.
 *
 * Run:
 *   node tests/integration/sdk/v8-api-smoke.mjs
 *   RELAY_BASE_URL=https://api.relaycast.dev node tests/integration/sdk/v8-api-smoke.mjs
 *
 * Exits 0 on success, non-zero on the first failed assertion.
 */
import assert from 'node:assert/strict';

import { AgentRelay } from '@agent-relay/sdk';

const baseUrl = process.env.RELAY_BASE_URL || undefined;

async function main() {
  // 1) Workspace + persisted key
  const relay = await AgentRelay.createWorkspace({ name: `v8-smoke-${Date.now()}`, baseUrl });
  assert.ok(relay.workspaceKey, 'createWorkspace returns a workspaceKey');

  // 2) register() returns live clients — single in → one client, array in → array
  const alice = await relay.workspace.register({ name: 'Alice', type: 'agent' });
  assert.equal(alice.name, 'Alice');
  assert.ok(alice.id && alice.handle, 'live client carries identity');
  assert.equal(typeof alice.status.becomes, 'function', 'live client carries status predicate builder');

  const [bob, carol] = await relay.workspace.register([
    { name: 'Bob', type: 'agent' },
    { name: 'Carol', type: 'agent' },
  ]);
  assert.equal(bob.name, 'Bob');
  assert.equal(carol.name, 'Carol');

  // 3) Duplicate name is rejected
  await assert.rejects(
    () => relay.workspace.register({ name: 'Alice', type: 'agent' }),
    'register rejects a duplicate name'
  );

  // 4) reconnect() rehydrates from a persisted token
  const aliceAgain = await relay.workspace.reconnect({ apiToken: alice.token });
  assert.equal(aliceAgain.id, alice.id, 'reconnect resolves the same identity');

  // 5) Channels
  await alice.channels.create({ name: 'general', topic: 'Team chat' });
  await bob.channels.join('general');
  await carol.channels.join('general');

  // 6) Listener — one discriminated event with a rich envelope
  const seen = [];
  const stop = relay.addListener('message.created', ({ message, envelope }) => {
    if (envelope.channel?.name === 'general') {
      seen.push({ from: envelope.from?.name, text: message.text, messageId: message.messageId });
    }
  });

  // 7) Sends: channel, then capture a messageId
  await alice.sendMessage({ to: '#general', text: 'standup in 5' });
  const { messageId } = await bob.sendMessage({ to: '#general', text: 'copy that' });
  assert.ok(messageId, 'sendMessage returns a messageId');

  // 8) Thread reply + reaction keyed on messageId
  await carol.reply({ messageId, text: 'on my way' });
  await alice.react({ messageId, emoji: ':thumbsup:' });

  // 9) DM and group DM routing
  await alice.sendMessage({ to: '@Bob', text: 'ping' });
  await alice.sendMessage({ to: ['@Bob', '@Carol'], text: 'group ping' });

  // 10) Inbound webhook → { url, token }, then post into the channel
  const hook = await relay.webhooks.createInbound({ channel: '#general' });
  assert.ok(hook.url && hook.token, 'createInbound returns url + token');
  const res = await fetch(hook.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hook.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'deploy started', author: 'github-actions[bot]' }),
  });
  assert.ok(res.ok, `inbound webhook POST succeeded (status ${res.status})`);

  // give realtime events a beat to arrive
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(seen.length >= 2, `listener received channel messages (got ${seen.length})`);

  stop();
  console.log(`v8 smoke OK — observed ${seen.length} channel messages, messageId=${messageId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
