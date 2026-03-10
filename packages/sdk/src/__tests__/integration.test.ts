import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

import { AgentRelayClient, AgentRelayProcessError } from '../client.js';
import { RelayCast } from '@relaycast/sdk';

function resolveBinaryPath(): string {
  if (process.env.AGENT_RELAY_BIN) {
    return process.env.AGENT_RELAY_BIN;
  }
  return path.resolve(process.cwd(), '../../target/debug/agent-relay-broker');
}

function resolveBundledBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  return path.resolve(process.cwd(), 'bin', exe);
}

// Ensure RELAY_API_KEY is available before any tests run.
// Creates an ephemeral workspace if no key is set.
before(async () => {
  if (process.env.RELAY_API_KEY?.trim()) return;
  const ws = await RelayCast.createWorkspace(`sdk-test-${Date.now().toString(36)}`);
  const workspace = ws as { apiKey?: string; api_key?: string };
  const apiKey = workspace.apiKey ?? workspace.api_key;
  if (!apiKey) {
    throw new Error('RelayCast.createWorkspace() did not return an API key');
  }
  process.env.RELAY_API_KEY = apiKey;
});

test('sdk can use bundled binary by default', async (t) => {
  const bundledBinary = resolveBundledBinaryPath();
  if (!fs.existsSync(bundledBinary)) {
    t.skip(`bundled binary not found at ${bundledBinary}`);
    return;
  }

  const client = await AgentRelayClient.start({
    env: process.env,
  });

  try {
    const agents = await client.listAgents();
    assert.ok(Array.isArray(agents), 'listAgents should return an array');
  } finally {
    await client.shutdown();
  }
});

test('sdk can start broker and manage agent lifecycle', async (t) => {
  const binaryPath = resolveBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`agent-relay-broker binary not found at ${binaryPath}`);
    return;
  }

  const client = await AgentRelayClient.start({
    binaryPath,
    requestTimeoutMs: 8_000,
    shutdownTimeoutMs: 2_000,
    env: process.env,
  });

  const spawnedName = `sdk-test-${Date.now().toString(36)}`;
  const seenEvents: string[] = [];
  const unsub = client.onEvent((event) => {
    seenEvents.push(event.kind);
  });

  try {
    const spawned = await client.spawnPty({
      name: spawnedName,
      cli: 'cat',
      channels: ['general'],
    });
    assert.equal(spawned.name, spawnedName);
    assert.equal(spawned.runtime, 'pty');

    const agentsAfterSpawn = await client.listAgents();
    const spawnedAgent = agentsAfterSpawn.find((agent) => agent.name === spawnedName);
    assert.ok(spawnedAgent, 'spawned agent should be present in listAgents()');
    assert.equal(spawnedAgent?.runtime, 'pty');

    const released = await client.release(spawnedName);
    assert.equal(released.name, spawnedName);

    const agentsAfterRelease = await client.listAgents();
    assert.equal(
      agentsAfterRelease.some((agent) => agent.name === spawnedName),
      false,
      'released agent should not be present in listAgents()'
    );

    assert.ok(seenEvents.includes('agent_spawned'), 'expected agent_spawned event');
    assert.ok(seenEvents.includes('agent_released'), 'expected agent_released event');
  } finally {
    unsub();
    await client.shutdown();
  }
});

test('sdk can spawn and release provider worker with transport override', async (t) => {
  const binaryPath = resolveBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`agent-relay-broker binary not found at ${binaryPath}`);
    return;
  }

  const client = await AgentRelayClient.start({
    binaryPath,
    requestTimeoutMs: 8_000,
    shutdownTimeoutMs: 2_000,
    env: process.env,
  });

  const spawnedName = `sdk-headless-${Date.now().toString(36)}`;
  const seenEvents: string[] = [];
  const unsub = client.onEvent((event) => {
    seenEvents.push(event.kind);
  });

  try {
    const spawned = await client.spawnClaude({
      name: spawnedName,
      transport: 'headless',
      channels: ['general'],
    });
    assert.equal(spawned.name, spawnedName);
    assert.equal(spawned.runtime, 'headless');

    const agentsAfterSpawn = await client.listAgents();
    const spawnedAgent = agentsAfterSpawn.find((agent) => agent.name === spawnedName);
    assert.ok(spawnedAgent, 'spawned headless agent should be present in listAgents()');
    assert.equal(spawnedAgent?.runtime, 'headless');

    const released = await client.release(spawnedName);
    assert.equal(released.name, spawnedName);

    const agentsAfterRelease = await client.listAgents();
    assert.equal(
      agentsAfterRelease.some((agent) => agent.name === spawnedName),
      false,
      'released headless agent should not be present in listAgents()'
    );

    assert.ok(seenEvents.includes('agent_spawned'), 'expected agent_spawned event');
    assert.ok(seenEvents.includes('agent_released'), 'expected agent_released event');
  } finally {
    unsub();
    await client.shutdown();
  }
});

test('sdk surfaces process error when binary is missing', async () => {
  await assert.rejects(
    AgentRelayClient.start({
      binaryPath: '/definitely/missing/agent-relay-broker',
      requestTimeoutMs: 1_000,
    }),
    (error: unknown) => {
      return error instanceof AgentRelayProcessError || error instanceof Error;
    }
  );
});

test('sdk includes broker stderr details when startup fails', async (t) => {
  const binaryPath = resolveBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`agent-relay-broker binary not found at ${binaryPath}`);
    return;
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-broker-lock-'));
  const first = await AgentRelayClient.start({
    binaryPath,
    cwd,
    requestTimeoutMs: 8_000,
    shutdownTimeoutMs: 2_000,
    env: process.env,
  });

  try {
    await assert.rejects(
      AgentRelayClient.start({
        binaryPath,
        cwd,
        requestTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
        env: process.env,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AgentRelayProcessError || error instanceof Error);
        assert.match(String((error as Error).message), /another broker instance is already running/i);
        return true;
      }
    );
  } finally {
    await first.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sdk writes broker lifecycle logs to stderr so stdout stays machine-readable', async (t) => {
  const binaryPath = resolveBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    t.skip(`agent-relay-broker binary not found at ${binaryPath}`);
    return;
  }

  const loggedStdout: string[] = [];
  const loggedStderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    loggedStdout.push(args.map((arg) => String(arg)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    loggedStderr.push(args.map((arg) => String(arg)).join(' '));
  };

  let client: AgentRelayClient | undefined;
  try {
    client = await AgentRelayClient.start({
      binaryPath,
      requestTimeoutMs: 8_000,
      shutdownTimeoutMs: 2_000,
      env: process.env,
    });

    await client.listAgents();

    assert.equal(
      loggedStdout.some((line) => line.includes('[broker] Starting:') || line.includes('[broker] Broker ready')),
      false,
      `broker lifecycle logs should not be written to stdout: ${loggedStdout.join('\n')}`
    );
    assert.ok(
      loggedStderr.some((line) => line.includes('[broker] Starting:')),
      `expected broker start log on stderr, got: ${loggedStderr.join('\n')}`
    );
    assert.ok(
      loggedStderr.some((line) => line.includes('[broker] Broker ready')),
      `expected broker ready log on stderr, got: ${loggedStderr.join('\n')}`
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await client?.shutdown();
  }
});
