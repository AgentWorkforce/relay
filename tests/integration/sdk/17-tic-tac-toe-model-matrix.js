#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AgentRelay, Models } from '@agent-relay/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isCliAvailable(cli) {
  return spawnSync('which', [cli], { stdio: 'ignore' }).status === 0;
}

function resolveLocalBrokerBinaryPath() {
  const releasePath = path.join(repoRoot, 'target', 'release', 'agent-relay-broker');
  if (fs.existsSync(releasePath)) return releasePath;

  const debugPath = path.join(repoRoot, 'target', 'debug', 'agent-relay-broker');
  if (fs.existsSync(debugPath)) return debugPath;

  throw new Error(
    'Local broker binary not found. Build it first with `cargo build` or `cargo build --release`.'
  );
}

function modelValues(group) {
  return [...new Set(Object.values(group).filter((v) => typeof v === 'string' && v.trim() !== ''))];
}

function playerTask({ mark, opponentName, channel }) {
  const firstTurn = mark === 'X' ? 'You move first.' : 'You move second.';
  return [
    `Play tic-tac-toe as ${mark} against ${opponentName} in #${channel}. ${firstTurn}`,
    'Rules:',
    '- Keep a valid 3x3 board state and only make legal moves.',
    '- On your turn, post exactly one line: MOVE:<cell> where <cell> is 1-9.',
    '- If game is won or drawn, post exactly one line: GAME_OVER:<WIN|DRAW>.',
    '- Immediately output /exit after GAME_OVER.',
    '- If opponent posts GAME_OVER, immediately output /exit.',
    '- Do not ask questions and do not output extra commentary.',
  ].join('\n');
}

function createRelay(apiKey, binaryPath, channel) {
  const opts = {
    binaryPath,
    channels: [channel],
    env: {
      ...process.env,
      RELAY_API_KEY: apiKey,
    },
  };

  return new AgentRelay(opts);
}

async function runGame({ apiKey, binaryPath, xProvider, xModel, oProvider, oModel, label }) {
  const channel = uniqueId('tic-tac-toe');
  const xName = `PlayerX-${uniqueId('x')}`;
  const oName = `PlayerO-${uniqueId('o')}`;
  const relay = createRelay(apiKey, binaryPath, channel);

  relay.onMessageReceived = (msg) => {
    const text = (msg.text ?? '').trim();
    if (text) {
      console.log(`[${label}] [${msg.from}] ${text}`);
    }
  };

  let x;
  let o;
  try {
    console.log(`\n=== ${label} ===`);
    console.log(`X: ${xProvider}:${xModel}`);
    console.log(`O: ${oProvider}:${oModel}`);
    console.log(`channel: #${channel}`);

    x = await relay[xProvider].spawn({
      name: xName,
      model: xModel,
      channels: [channel],
      task: playerTask({ mark: 'X', opponentName: oName, channel }),
    });

    if (relay.observerUrl) {
      console.log(`[${label}] observer: ${relay.observerUrl}`);
    }

    o = await relay[oProvider].spawn({
      name: oName,
      model: oModel,
      channels: [channel],
      task: playerTask({ mark: 'O', opponentName: xName, channel }),
    });

    await Promise.all([relay.waitForAgentReady(xName), relay.waitForAgentReady(oName)]);

    await relay
      .system()
      .sendMessage({ to: xName, text: `Start the game now in #${channel}.` });

    const [xResult, oResult] = await Promise.all([x.waitForExit(), o.waitForExit()]);

    assert.equal(xResult, 'exited', `${label}: ${xName} must self-exit via /exit`);
    assert.equal(oResult, 'exited', `${label}: ${oName} must self-exit via /exit`);

    console.log(`[${label}] PASS: both agents exited`);
  } finally {
    await Promise.allSettled([
      x ? x.release('cleanup') : Promise.resolve(),
      o ? o.release('cleanup') : Promise.resolve(),
    ]);
    await relay.shutdown().catch(() => {});
  }
}

async function main() {
  if (process.env.RELAY_INTEGRATION_REAL_CLI !== '1') {
    console.log('SKIP: set RELAY_INTEGRATION_REAL_CLI=1 to run real tic-tac-toe model matrix test');
    return;
  }

  const relayApiKey = process.env.RELAY_API_KEY?.trim();
  if (!relayApiKey) {
    console.log(
      'SKIP: set RELAY_API_KEY. This test does not auto-provision workspaces or call setup APIs.'
    );
    return;
  }

  if (!isCliAvailable('claude') || !isCliAvailable('codex')) {
    console.log('SKIP: this test requires both `claude` and `codex` CLIs on PATH');
    return;
  }

  const binaryPath = resolveLocalBrokerBinaryPath();
  const claudeModels = modelValues(Models.Claude);
  const codexModels = modelValues(Models.Codex);

  assert.ok(claudeModels.length > 0, 'No Claude models found');
  assert.ok(codexModels.length > 0, 'No Codex models found');

  // 1) Claude-only matrix: each Claude model vs itself.
  for (const model of claudeModels) {
    await runGame({
      apiKey: relayApiKey,
      binaryPath,
      xProvider: 'claude',
      xModel: model,
      oProvider: 'claude',
      oModel: model,
      label: `claude:${model} vs claude:${model}`,
    });
  }

  // 2) Codex-only matrix: each Codex model vs itself.
  for (const model of codexModels) {
    await runGame({
      apiKey: relayApiKey,
      binaryPath,
      xProvider: 'codex',
      xModel: model,
      oProvider: 'codex',
      oModel: model,
      label: `codex:${model} vs codex:${model}`,
    });
  }

  // 3) Mixed matrix: rotate Claude models across all Codex models.
  for (let i = 0; i < codexModels.length; i += 1) {
    const codexModel = codexModels[i];
    const claudeModel = claudeModels[i % claudeModels.length];
    await runGame({
      apiKey: relayApiKey,
      binaryPath,
      xProvider: 'claude',
      xModel: claudeModel,
      oProvider: 'codex',
      oModel: codexModel,
      label: `mix claude:${claudeModel} vs codex:${codexModel}`,
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
