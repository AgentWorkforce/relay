/**
 * Quickstart integration tests — exercises the AgentRelay facade:
 * spawn agents, send messages, list, release, event hooks, shutdown.
 *
 * Run:
 *   npm run build && node --test dist/__tests__/quickstart.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key
 *   AGENT_RELAY_BIN (optional) — path to agent-relay-broker binary
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { AgentRelay, type Agent, type Message } from '../relay.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveBinaryPath(): string {
  if (process.env.AGENT_RELAY_BIN) {
    return process.env.AGENT_RELAY_BIN;
  }
  return path.resolve(process.cwd(), '../../target/debug/agent-relay-broker');
}

function requireRelaycast(t: TestContext): boolean {
  if (!process.env.RELAY_API_KEY?.trim()) {
    t.skip('RELAY_API_KEY is required');
    return false;
  }
  return true;
}

function requireBinary(t: TestContext): string | null {
  const bin = resolveBinaryPath();
  if (!fs.existsSync(bin)) {
    t.skip(`agent-relay-broker binary not found at ${bin}`);
    return null;
  }
  return bin;
}

// ── full lifecycle ──────────────────────────────────────────────────────────

test('facade: spawn → message → list → release → shutdown', async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = new AgentRelay({
    binaryPath: bin,
    requestTimeoutMs: 10_000,
    env: process.env,
  });

  const spawnedNames: string[] = [];
  const releasedNames: string[] = [];
  const receivedMessages: Message[] = [];
  const sentMessages: Message[] = [];

  relay.onAgentSpawned = (agent) => spawnedNames.push(agent.name);
  relay.onAgentReleased = (agent) => releasedNames.push(agent.name);
  relay.onMessageReceived = (msg) => receivedMessages.push(msg);
  relay.onMessageSent = (msg) => sentMessages.push(msg);

  try {
    // Spawn two agents in parallel
    const [codex, worker1] = await Promise.all([
      relay.codex.spawn({ name: `Codex-${suffix}` }),
      relay.spawnPty({
        name: `Worker1-${suffix}`,
        cli: 'cat',
        channels: ['general'],
      }),
    ]);

    assert.equal(codex.runtime, 'pty');
    assert.equal(worker1.runtime, 'pty');

    // Send a message from a human source
    const human = relay.human({ name: 'System' });
    const msg = await human.sendMessage({
      to: codex.name,
      text: 'Hello, world!',
    });
    assert.ok(msg.eventId, 'should return eventId');
    assert.equal(msg.from, 'System');
    assert.equal(msg.to, codex.name);

    // onMessageSent should have fired
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].text, 'Hello, world!');

    // List agents — should return Agent objects with release()
    const agents = await relay.listAgents();
    const names = agents.map((a) => a.name);
    assert.ok(names.includes(codex.name));
    assert.ok(names.includes(worker1.name));
    assert.equal(typeof agents[0].release, 'function');

    // Release all via agent.release()
    for (const agent of agents) {
      if (agent.name === codex.name || agent.name === worker1.name) {
        await agent.release();
      }
    }

    // Verify gone
    const remaining = await relay.listAgents();
    assert.ok(!remaining.some((a) => a.name === codex.name));
    assert.ok(!remaining.some((a) => a.name === worker1.name));

    // Event hooks should have fired
    assert.ok(spawnedNames.includes(codex.name));
    assert.ok(spawnedNames.includes(worker1.name));
    assert.ok(releasedNames.includes(codex.name));
    assert.ok(releasedNames.includes(worker1.name));
  } finally {
    await relay.shutdown();
  }
});

// ── agent.sendMessage ───────────────────────────────────────────────────────

test('facade: agent.sendMessage sends from the agent identity', async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = new AgentRelay({
    binaryPath: bin,
    requestTimeoutMs: 10_000,
    env: process.env,
  });

  const sentMessages: Message[] = [];
  relay.onMessageSent = (msg) => sentMessages.push(msg);

  try {
    const [a, b] = await Promise.all([
      relay.spawnPty({ name: `A-${suffix}`, cli: 'cat', channels: ['general'] }),
      relay.spawnPty({ name: `B-${suffix}`, cli: 'cat', channels: ['general'] }),
    ]);

    const msg = await a.sendMessage({ to: b.name, text: 'ping' });
    assert.equal(msg.from, a.name);
    assert.equal(msg.to, b.name);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].from, a.name);

    await a.release();
    await b.release();
  } finally {
    await relay.shutdown();
  }
});

// ── threading ───────────────────────────────────────────────────────────────

test('facade: message threading with threadId', async (t) => {
  if (!requireRelaycast(t)) return;
  const bin = requireBinary(t);
  if (!bin) return;

  const suffix = Date.now().toString(36);
  const relay = new AgentRelay({
    binaryPath: bin,
    requestTimeoutMs: 10_000,
    env: process.env,
  });

  try {
    const agent = await relay.spawnPty({
      name: `Thread-${suffix}`,
      cli: 'cat',
      channels: ['general'],
    });

    const human = relay.human({ name: 'Human' });
    const msg1 = await human.sendMessage({ to: agent.name, text: 'start' });
    const msg2 = await human.sendMessage({
      to: agent.name,
      text: 'follow-up',
      threadId: msg1.eventId,
    });

    assert.ok(msg2.eventId);
    assert.notEqual(msg1.eventId, msg2.eventId);

    await agent.release();
  } finally {
    await relay.shutdown();
  }
});
