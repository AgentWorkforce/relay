#!/usr/bin/env node

/**
 * Provider-backed acceptance check for relay#1891.
 *
 * This deliberately is not the RelayFlow CI runner: it uses an authenticated
 * interactive Codex CLI and therefore spends provider capacity.  Run it from
 * a disposable working directory after building the broker under test:
 *
 *   node tests/relayflows/cases/1891-codex-parked-composer-recovery/real-codex.mjs \
 *     --broker target/release/agent-relay-broker
 *
 * It proves the exact user-facing path. A Relay delivery arrives after Codex
 * has rendered its initial composer. The broker must observe actual Codex turn
 * activity, may issue bounded submit-only recovery, and must never inject the
 * body a second time. The response marker is checked only after turn activity,
 * so the instruction's editor echo cannot satisfy the test.
 */

import { constants as fsConstants } from 'node:fs';
import { access, chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const CASE_ID = '1891-codex-parked-composer-recovery';
const RESPONSE_MARKER = 'RELAY_1891_REAL_CODEX_ACK';
const BODY = [
  'Relay verification task.',
  `Reply with exactly ${RESPONSE_MARKER}.`,
  'Do not use tools, edit files, or ask a follow-up question.',
].join('\n');
const brokerPath = path.resolve(option('--broker', process.env.RELAY_REAL_CODEX_BROKER_BINARY ?? ''));
const resultPath = option('--result', '');
const timeoutSeconds = Number(option('--timeout-seconds', '180'));
const settleSeconds = Number(option('--settle-seconds', '60'));

if (!brokerPath || brokerPath === path.resolve('.')) {
  throw new Error('Pass --broker <built-agent-relay-broker> or RELAY_REAL_CODEX_BROKER_BINARY.');
}
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 20 || timeoutSeconds > 600) {
  throw new Error('--timeout-seconds must be an integer from 20 to 600.');
}
if (!Number.isSafeInteger(settleSeconds) || settleSeconds < 10 || settleSeconds > 120) {
  throw new Error('--settle-seconds must be an integer from 10 to 120.');
}
await assertExecutable(brokerPath, 'broker');
await requireCommand('codex');

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-real-codex-1891-'));
const cwd = path.join(probeDir, 'workspace');
const codexHome = path.join(probeDir, 'codex-home');
const agentName = `relayflow-real-codex-1891-${process.pid}`;
let worker;
let stderr = '';

try {
  await mkdir(cwd, { recursive: true });
  await mkdir(codexHome, { mode: 0o700 });
  // Codex must have separate SQLite state from the live sessions on this
  // machine. Copy only the login into a private disposable home.
  const authSource = path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME, '.codex'), 'auth.json');
  const authCopy = path.join(codexHome, 'auth.json');
  await copyFile(authSource, authCopy);
  await chmod(authCopy, 0o600);
  worker = spawn(
    brokerPath,
    [
      'pty',
      '--agent-name',
      agentName,
      'codex',
      '--',
      '--config',
      'check_for_update_on_startup=false',
      '--model',
      'gpt-6-sol',
      '--config',
      'model_reasoning_effort="low"',
      '--sandbox',
      'workspace-write',
      '--no-daemon',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        // The disposable cwd prevents the check from modifying a repository.
        RELAY_INJECT_RATE_MS: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  worker.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  const frames = createFrameQueue(worker, () => stderr);

  sendFrame(worker, { v: 2, type: 'init_worker', payload: { agent: { name: agentName } } });
  await frames.waitFor(
    (frame) => frame.type === 'worker_stream' && typeof frame.payload?.chunk === 'string',
    45_000,
    'initial interactive Codex output'
  );
  const dismissedUpdateDialogs = await settleCodexComposer(worker, frames, settleSeconds * 1_000);
  if (frames.count('worker_ready') === 0) {
    await frames.waitFor((frame) => frame.type === 'worker_ready', 30_000, 'broker worker readiness');
  }

  sendFrame(worker, {
    v: 2,
    type: 'deliver_relay',
    request_id: 'relayflow-real-codex-delivery',
    payload: {
      delivery_id: 'delivery_relayflow_real_codex_1891',
      event_id: 'event_relayflow_real_codex_1891',
      from: 'relayflow-verifier',
      target: agentName,
      body: BODY,
      priority: 2,
      injection_mode: 'wait',
    },
  });

  // Capture a post-paste grid before the recovery deadline. This becomes
  // bounded local evidence if a future Codex rendering change prevents the
  // parked-composer recognizer from arming submit-only recovery.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  sendFrame(worker, {
    v: 2,
    type: 'snapshot_pty',
    request_id: 'real-codex-parked-snapshot',
    payload: { format: 'plain' },
  });
  const parkedSnapshot = await frames.waitFor(
    (frame) => frame.type === 'snapshot_response' && frame.request_id === 'real-codex-parked-snapshot',
    10_000,
    'post-paste Codex snapshot'
  );

  const observation = await observeOneCodexTurn(
    worker,
    frames,
    parkedSnapshot.payload,
    timeoutSeconds * 1_000
  );
  if (observation.deliveryInjections !== 1) {
    throw new Error(`Expected one body injection, observed ${observation.deliveryInjections}.`);
  }
  if (
    observation.recoveries.length > 2 ||
    observation.recoveries.some((strategy) => strategy !== 'submit_key_only')
  ) {
    throw new Error(`Unexpected recovery strategy: ${JSON.stringify(observation.recoveries)}.`);
  }
  if (!observation.verified) throw new Error('Broker never verified harness acceptance.');
  await waitForVisibleAnswer(worker, frames, 120_000);

  const result = {
    version: 1,
    caseId: CASE_ID,
    outcome: 'passed',
    signature:
      observation.recoveries.length > 0
        ? 'real_codex_parked_delivery_recovers_once'
        : 'real_codex_delivery_completes_once',
    deliveryInjections: observation.deliveryInjections,
    submitOnlyRecoveries: observation.recoveries.length,
    dismissedUpdateDialogs,
  };
  if (resultPath) {
    await mkdir(path.dirname(path.resolve(resultPath)), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result)}\n`, 'utf8');
  }
  console.log(`REAL_CODEX_1891_PASS ${JSON.stringify(result)}`);
} finally {
  if (worker?.exitCode === null) {
    sendFrame(worker, { v: 2, type: 'shutdown_worker', payload: { reason: 'real Codex proof complete' } });
    await Promise.race([
      new Promise((resolve) => worker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  await rm(probeDir, { recursive: true, force: true });
}

async function settleCodexComposer(worker, frames, settleMs) {
  const deadline = Date.now() + settleMs;
  let cleanSince;
  let dismissed = 0;
  let acceptedDisposableFolder = false;
  let snapshotIndex = 0;
  let lastScreen = '';
  while (true) {
    const snapshot = await snapshotPty(worker, frames, `real-codex-settle-${snapshotIndex++}`);
    const screen = String(snapshot.payload?.screen ?? '');
    lastScreen = screen;
    if (screen.includes('Trust this folder?') && screen.includes('Trust and continue')) {
      // The cwd was created by this test and contains no project files.
      await writePty(worker, frames, 'real-codex-trust-disposable-folder', '\r');
      acceptedDisposableFolder = true;
      cleanSince = undefined;
      await sleep(750);
      continue;
    }
    if (hasCodexUpdateDialog(screen)) {
      // Escape closes this specific client-side update prompt. This runs before
      // Relay delivery, so it cannot cancel delivery verification or simulate a
      // user submitting the Relay body.
      await writePty(worker, frames, `real-codex-dismiss-update-${dismissed}`, '\u001b');
      dismissed += 1;
      cleanSince = undefined;
      await sleep(750);
      continue;
    }
    if (isEmptyCodexComposer(screen)) {
      cleanSince ??= Date.now();
    } else {
      cleanSince = undefined;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (cleanSince && Date.now() - cleanSince >= 5_000) return dismissed;
      throw new Error(
        `Codex did not remain at an empty composer for five seconds: ${JSON.stringify({
          dismissedUpdateDialogs: dismissed,
          acceptedDisposableFolder,
          screen: lastScreen.slice(-4_000),
        })}`
      );
    }
    await sleep(Math.min(1_000, remaining));
  }
}

function hasCodexUpdateDialog(screen) {
  return /Update available/i.test(screen) && /Skip(?: until next version)?/i.test(screen);
}

function isEmptyCodexComposer(screen) {
  return (
    /Ask Codex to do anything/i.test(screen) &&
    !screen.includes('Trust this folder?') &&
    !hasCodexUpdateDialog(screen) &&
    !/(?:Working \(|esc to interrupt|thinking|processing)/i.test(screen)
  );
}

async function snapshotPty(worker, frames, requestId) {
  sendFrame(worker, {
    v: 2,
    type: 'snapshot_pty',
    request_id: requestId,
    payload: { format: 'plain' },
  });
  return frames.waitFor(
    (frame) => frame.type === 'snapshot_response' && frame.request_id === requestId,
    10_000,
    `PTY snapshot ${requestId}`
  );
}

async function writePty(worker, frames, requestId, data) {
  sendFrame(worker, {
    v: 2,
    type: 'write_pty',
    request_id: requestId,
    payload: { data },
  });
  const response = await frames.waitFor(
    (frame) => frame.type === 'write_pty_response' && frame.request_id === requestId,
    10_000,
    `PTY write ${requestId}`
  );
  if (response.payload?.error) throw new Error(`PTY write failed: ${JSON.stringify(response.payload.error)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function observeOneCodexTurn(worker, frames, parkedSnapshot, timeoutMs) {
  let deliveryInjections = frames.count('delivery_injected');
  const recoveries = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await frames.next(Math.min(1_000, deadline - Date.now()));
    if (!frame) continue;
    if (frame.type === 'delivery_injected') deliveryInjections = frames.count('delivery_injected');
    if (frame.type === 'delivery_resubmitted') recoveries.push(frame.payload?.strategy);
    if (frame.type === 'delivery_verified') {
      return { deliveryInjections, recoveries, verified: true };
    }
    if (frame.type === 'delivery_failed') {
      const snapshot = await snapshotPty(worker, frames, 'real-codex-rejected-snapshot');
      throw new Error(
        `Broker rejected the real Codex delivery: ${JSON.stringify({
          reason: frame.payload?.reason,
          deliveryInjections,
          recoveries,
          cursor: snapshot.payload?.cursor,
          screen: String(snapshot.payload?.screen ?? '').slice(-4_000),
        })}`
      );
    }
  }
  const finalSnapshot = await snapshotPty(worker, frames, 'real-codex-final-snapshot');
  throw new Error(
    `Timed out awaiting one accepted Codex turn: ${JSON.stringify({
      deliveryInjections,
      recoveries,
      parkedSnapshot: {
        cursor: parkedSnapshot?.cursor,
        screen: String(parkedSnapshot?.screen ?? '').slice(-4_000),
      },
      finalScreen: String(finalSnapshot.payload?.screen ?? '').slice(-4_000),
      frames: frames.debugSummary(),
    })}`
  );
}

async function waitForVisibleAnswer(worker, frames, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastScreen = '';
  let count = 0;
  while (Date.now() < deadline) {
    const snapshot = await snapshotPty(worker, frames, `real-codex-answer-${count++}`);
    lastScreen = String(snapshot.payload?.screen ?? '');
    const answerLines = lastScreen.split('\n').filter((line) => line.trim() === `• ${RESPONSE_MARKER}`);
    if (answerLines.length === 1 && isEmptyCodexComposer(lastScreen)) return;
    if (answerLines.length > 1) break;
    await sleep(1_000);
  }
  throw new Error(
    `Codex did not finish exactly one visible answer: ${JSON.stringify({
      answerCount: lastScreen.split('\n').filter((line) => line.trim() === `• ${RESPONSE_MARKER}`).length,
      screen: lastScreen.slice(-4_000),
    })}`
  );
}

function createFrameQueue(child, getStderr) {
  const queue = [];
  const recent = [];
  const counts = new Map();
  const waiters = new Set();
  let parseError;
  let exitError;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const frame = JSON.parse(line);
      queue.push(frame);
      counts.set(frame.type, (counts.get(frame.type) ?? 0) + 1);
      recent.push({ type: frame.type, requestId: frame.request_id });
      if (recent.length > 30) recent.shift();
    } catch (error) {
      parseError = new Error(`Broker emitted invalid JSON: ${error.message}; line=${line.slice(0, 2_000)}`);
    }
    for (const notify of waiters) notify();
  });
  child.once('exit', (code, signal) => {
    exitError = new Error(
      `Broker exited before proof completed (${signal ?? code ?? 'unknown'}): ${JSON.stringify({ stderr: getStderr(), counts: Object.fromEntries(counts), recent })}`
    );
    for (const notify of waiters) notify();
  });
  const awaitChange = (timeoutMs) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(notify);
        resolve();
      }, timeoutMs);
      const notify = () => {
        clearTimeout(timer);
        waiters.delete(notify);
        resolve();
      };
      waiters.add(notify);
    });
  return {
    count(type) {
      return counts.get(type) ?? 0;
    },
    debugSummary() {
      return { counts: Object.fromEntries(counts), recent };
    },
    async next(timeoutMs) {
      if (parseError) throw parseError;
      if (exitError) throw exitError;
      if (queue.length > 0) return queue.shift();
      await awaitChange(timeoutMs);
      if (parseError) throw parseError;
      if (exitError) throw exitError;
      return queue.shift();
    },
    async waitFor(predicate, timeoutMs, label) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = await this.next(Math.min(500, deadline - Date.now()));
        if (frame && predicate(frame)) return frame;
      }
      throw new Error(`Timed out waiting for ${label}: ${getStderr()}`);
    },
  };
}

function sendFrame(child, frame) {
  if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function assertExecutable(candidate, name) {
  try {
    await access(candidate, fsConstants.X_OK);
  } catch {
    throw new Error(`${name} must be an executable file: ${candidate}`);
  }
}

async function requireCommand(command) {
  const result = await new Promise((resolve) => {
    const child = spawn('sh', ['-lc', `command -v ${command}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
  if (!result) throw new Error(`${command} must be on PATH for the provider-backed proof.`);
}
