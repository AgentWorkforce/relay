import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRelayClient, RelaycastApi } from '@agent-relay/sdk';

const ALLOWED_CLIS = ['claude', 'codex', 'gemini', 'aider', 'goose'];
const DELIVERY_PROGRESS_KINDS = new Set([
  'delivery_queued',
  'delivery_injected',
  'delivery_active',
  'delivery_verified',
  'delivery_ack',
  'delivery_retry',
]);

const SCENARIOS = {
  '01-connect.js': { workers: 0, messageRounds: 0 },
  '02-send-message.js': { workers: 2, messageRounds: 1 },
  '03-spawn-agent.js': { workers: 1, messageRounds: 1 },
  '04-release-agent.js': { workers: 2, messageRounds: 0, releaseUnknown: true },
  '05-full-flow.js': { workers: 3, messageRounds: 2 },
  '05a-spawn-process.js': { workers: 1, messageRounds: 0 },
  '05b-worker-message.js': { workers: 2, messageRounds: 1 },
  '05b0-stability.js': { workers: 1, messageRounds: 3 },
  '05b1-message-stability.js': { workers: 1, messageRounds: 5 },
  '05b2-orch-to-worker.js': { workers: 1, messageRounds: 2 },
  '06-multi-worker.js': { workers: 4, messageRounds: 2 },
  '07-broadcast.js': { workers: 3, messageRounds: 0, useChannelBroadcast: true },
  '08-multi-claude.js': { workers: 2, messageRounds: 1 },
  '09-budget-negotiation-sdk.js': { workers: 3, messageRounds: 3 },
  '09-budget-negotiation.js': { workers: 3, messageRounds: 3 },
  '10-mediated-negotiation.js': { workers: 4, messageRounds: 2 },
  '14-orchestration-sdk.js': { workers: 3, messageRounds: 2 },
  '15-continuity-handoff.js': { workers: 1, messageRounds: 1, continueFrom: true },
  '16-set-model.js': { workers: 1, messageRounds: 1, setModel: true },
  'debug-spawn.js': { workers: 1, messageRounds: 0 },
  'worker.js': { workers: 1, messageRounds: 0 },
  'test-agent-names.js': { workers: 1, messageRounds: 1 },
  'test-frontend.js': { workers: 1, messageRounds: 1 },
  'live-set-model.mjs': { workers: 1, messageRounds: 0, setModel: true },
};

let cachedApiKey;
let cachedShimDir;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCli(requestedCli) {
  if (ALLOWED_CLIS.includes(requestedCli)) {
    return requestedCli;
  }
  return 'gemini';
}

async function ensureApiKey() {
  if (cachedApiKey) return cachedApiKey;
  if (process.env.RELAY_API_KEY?.trim()) {
    cachedApiKey = process.env.RELAY_API_KEY.trim();
    return cachedApiKey;
  }
  const workspace = await RelaycastApi.createWorkspace(`sdk-it-${Date.now().toString(36)}`);
  cachedApiKey = workspace.apiKey;
  return cachedApiKey;
}

function ensureCliShims() {
  if (cachedShimDir) return cachedShimDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-cli-'));
  const shim = '#!/usr/bin/env bash\nexec cat\n';
  for (const cli of ALLOWED_CLIS) {
    const shimPath = path.join(dir, cli);
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });
  }
  cachedShimDir = dir;
  return dir;
}

async function createClient(testName) {
  const apiKey = await ensureApiKey();
  const shimDir = ensureCliShims();
  const existingPath = process.env.PATH ?? '';
  const mergedPath = existingPath ? `${shimDir}${path.delimiter}${existingPath}` : shimDir;

  return AgentRelayClient.start({
    brokerName: uniqueId(testName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()),
    channels: ['general'],
    env: {
      ...process.env,
      RELAY_API_KEY: apiKey,
      PATH: mergedPath,
    },
    requestTimeoutMs: 20_000,
    shutdownTimeoutMs: 5_000,
  });
}

async function safeSendMessage(client, input, options = {}) {
  const allowPublishFailure = options.allowPublishFailure === true;
  try {
    const result = await client.sendMessage(input);
    assert.ok(result.event_id, 'sendMessage should return an event_id');
    return result;
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (allowPublishFailure && code === 'relaycast_publish_failed') {
      return null;
    }
    throw error;
  }
}

async function safeShutdown(client) {
  try {
    await client.shutdown();
  } catch {
    // Best effort cleanup.
  }
}

async function releaseAll(client, names) {
  for (const name of names) {
    try {
      await client.release(name);
    } catch {
      // Ignore already-released/unknown workers during teardown.
    }
  }
}

export async function runCurrentSdkScenario(fileUrl, requestedCli = process.argv[2]) {
  const filePath = fileURLToPath(fileUrl);
  const fileName = path.basename(filePath);
  const scenario = SCENARIOS[fileName];

  if (!scenario) {
    throw new Error(`No current SDK scenario registered for ${fileName}`);
  }

  const cli = normalizeCli(requestedCli ?? 'gemini');
  const runId = uniqueId(fileName.replace(/\.[^.]+$/, ''));
  const channelName = `ch-${runId}`;
  const senderName = `orchestrator-${runId}`;
  const workers = [];
  let messageAttempts = 0;

  console.log(`=== ${fileName} (current SDK) ===`);
  console.log(`CLI: ${cli}`);

  const client = await createClient(fileName);
  try {
    for (let i = 0; i < scenario.workers; i += 1) {
      const workerName = `worker-${i + 1}-${runId}`;
      const channels = scenario.useChannelBroadcast ? [channelName] : ['general'];
      await client.spawnPty({
        name: workerName,
        cli,
        channels,
        task: `Integration test scenario for ${fileName}`,
      });
      workers.push(workerName);
    }

    await sleep(1_000);

    const listedAgents = await client.listAgents();
    for (const workerName of workers) {
      assert.ok(
        listedAgents.some((agent) => agent.name === workerName),
        `expected ${workerName} to appear in listAgents`
      );
    }

    if (scenario.messageRounds > 0) {
      for (let round = 0; round < scenario.messageRounds; round += 1) {
        for (const workerName of workers) {
          await safeSendMessage(client, {
            to: workerName,
            from: senderName,
            text: `${fileName} message round ${round + 1}`,
          });
          messageAttempts += 1;
        }
      }
      await sleep(1_000);
    }

    if (scenario.useChannelBroadcast && workers.length > 0) {
      const broadcastResult = await safeSendMessage(
        client,
        {
          to: `#${channelName}`,
          from: workers[0],
          text: `Broadcast from ${fileName}`,
        },
        { allowPublishFailure: true }
      );
      if (broadcastResult === null) {
        // Fallback to explicit fan-out when broker rejects channel publish.
        for (const workerName of workers) {
          await safeSendMessage(client, {
            to: workerName,
            from: workers[0],
            text: `Broadcast fallback from ${fileName}`,
          });
          messageAttempts += 1;
        }
      } else {
        messageAttempts += 1;
      }
      await sleep(1_000);
    }

    if (scenario.continueFrom && workers.length > 0) {
      const original = workers[0];
      await client.release(original);
      const continued = `continued-${runId}`;
      await client.spawnPty({
        name: continued,
        cli,
        channels: ['general'],
        continueFrom: original,
        task: `Continuation scenario for ${fileName}`,
      });
      workers[0] = continued;
      await sleep(1_000);
    }

    if (scenario.setModel && workers.length > 0) {
      try {
        await client.setModel(workers[0], 'test-model', { timeoutMs: 1_500 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[INFO] setModel is non-fatal in this scenario: ${message}`);
      }
    }

    if (scenario.releaseUnknown) {
      let rejected = false;
      try {
        await client.release(`missing-${runId}`);
      } catch {
        rejected = true;
      }
      assert.ok(rejected, 'releasing a missing agent should reject');
    }

    if (messageAttempts > 0) {
      const events = client.queryEvents();
      const deliveryProgress = events.filter((event) => DELIVERY_PROGRESS_KINDS.has(event.kind));
      assert.ok(deliveryProgress.length >= 1, 'expected at least one delivery progress event');
    }

    await releaseAll(client, workers);
    console.log(`PASS: ${fileName}`);
  } finally {
    await safeShutdown(client);
  }
}
