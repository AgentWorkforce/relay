import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createTaskSubmissionObserver } from './task-observation.mjs';

const CASE_ID = '1634-claude-multiline-task-submit';
const SUBMIT_BOUNDARY_MS = 150;
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = await requiredExecutable('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1634-'));
const binDir = path.join(probeDir, 'bin');
const fakeClaudePath = path.join(binDir, 'claude');
const fakeClaudeSource = String.raw`#!/usr/bin/env node
const thresholdMs = Number(process.env.RELAY_PROOF_SUBMIT_BOUNDARY_MS);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Welcome back Relay!\r\n❯');

let lastBodyByteAt = performance.now();
let composer = '';
let decided = false;

function composerContainsCompleteTask() {
  return (
    composer.includes('Review the live source.') &&
    composer.includes('Write the requested review artifact when complete.')
  );
}

function runSubmittedTask(gapMs) {
  const marker = composerContainsCompleteTask() ? 'TASK_STARTED' : 'TASK_REJECTED';
  process.stdout.write('\r\n' + marker + ' gap_ms=' + gapMs + '\r\n');
  composer = '';
}

process.stdin.on('data', (chunk) => {
  // One read is one delivery burst. Reusing its arrival timestamp prevents
  // per-byte processing pauses from making Body+Enter in the same chunk look
  // like a delayed submit.
  const receivedAt = performance.now();
  for (const byte of chunk) {
    if (byte === 13 && composer.length > 0 && !decided) {
      const gapMs = Math.round(receivedAt - lastBodyByteAt);
      if (gapMs < thresholdMs) {
        // Model Claude's multiline paste composer: Enter inside the paste
        // burst becomes another composer newline instead of submitting.
        composer += '\n';
        process.stdout.write('\r\nTASK_PARKED gap_ms=' + gapMs + '\r\n');
      } else {
        // A distinct Enter after the paste boundary submits the composer. The
        // task handler independently checks that the full multiline brief was
        // received before reporting a start.
        runSubmittedTask(gapMs);
      }
      decided = true;
      continue;
    }
    if (byte !== 13) {
      composer += String.fromCharCode(byte);
      lastBodyByteAt = receivedAt;
    }
  }
});
`;

let worker;
let stderr = '';
try {
  await mkdir(binDir, { recursive: true });
  await writeFile(fakeClaudePath, fakeClaudeSource, { encoding: 'utf8', mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);

  worker = spawn(binaryPath, ['pty', '--agent-name', 'relayflow-claude-probe', 'claude'], {
    cwd: targetDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      RELAY_INJECT_RATE_MS: '0',
      RELAY_PROOF_SUBMIT_BOUNDARY_MS: String(SUBMIT_BOUNDARY_MS),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  const frames = createFrameQueue(worker);
  sendFrame(worker, {
    v: 2,
    type: 'init_worker',
    payload: { agent: { name: 'relayflow-claude-probe' } },
  });
  await frames.waitFor((frame) => frame.type === 'worker_ready', 15_000, 'worker readiness');

  sendFrame(worker, {
    v: 2,
    type: 'deliver_relay',
    request_id: 'relayflow-delivery',
    payload: {
      delivery_id: 'delivery_relayflow_1634',
      event_id: 'event_relayflow_1634',
      from: 'broker',
      target: 'relayflow-claude-probe',
      body: 'Review the live source.\nWrite the requested review artifact when complete.',
      priority: 2,
      injection_mode: 'wait',
    },
  });

  const taskObserver = createTaskSubmissionObserver();
  let taskObservation;
  await frames.waitFor(
    (frame) => {
      taskObservation = taskObserver.observe(frame);
      return taskObservation !== undefined;
    },
    20_000,
    'task submission marker'
  );
  const { marker, gapMs, output } = taskObservation;

  let outcome;
  let signature;
  let details;
  if (marker === 'TASK_PARKED' && Number.isFinite(gapMs) && gapMs < SUBMIT_BOUNDARY_MS) {
    outcome = 'bug';
    signature = 'claude_multiline_task_left_in_composer';
    details = `The compiled broker's Enter arrived ${gapMs}ms after the body in the deterministic Claude composer model; the model retained it as a multiline newline and left the task unsubmitted.`;
  } else if (marker === 'TASK_STARTED' && Number.isFinite(gapMs) && gapMs >= SUBMIT_BOUNDARY_MS) {
    outcome = 'fixed';
    signature = 'claude_multiline_task_submitted';
    details = `The compiled broker delivered Enter as a distinct PTY write after ${gapMs}ms; the deterministic Claude composer model submitted the complete multiline brief and its task handler started it.`;
  } else {
    throw new Error(`Unexpected task marker ${JSON.stringify({ marker, gapMs, output })}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  if (worker && worker.exitCode === null) {
    sendFrame(worker, { v: 2, type: 'shutdown_worker', payload: { reason: 'proof complete' } });
    await Promise.race([
      new Promise((resolve) => worker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  await rm(probeDir, { recursive: true, force: true });
}

function createFrameQueue(child) {
  const queue = [];
  const waiters = new Set();
  let parseError;
  let exitError;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      queue.push(JSON.parse(line));
    } catch (error) {
      parseError = new Error(`Broker emitted invalid JSON: ${error.message}; line=${line.slice(0, 2_000)}`);
    }
    for (const notify of waiters) notify();
  });
  child.once('exit', (code, signal) => {
    exitError = new Error(`Broker exited before proof completed (${signal ?? code ?? 'unknown'}): ${stderr}`);
    for (const notify of waiters) notify();
  });

  return {
    async waitFor(predicate, timeoutMs, label) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (parseError) throw parseError;
        if (exitError) throw exitError;
        const index = queue.findIndex(predicate);
        if (index >= 0) return queue.splice(index, 1)[0];
        await new Promise((resolve) => {
          const timer = setTimeout(
            () => {
              waiters.delete(notify);
              resolve();
            },
            Math.min(100, Math.max(1, deadline - Date.now()))
          );
          const notify = () => {
            clearTimeout(timer);
            waiters.delete(notify);
            resolve();
          };
          waiters.add(notify);
        });
      }
      throw new Error(`Timed out waiting for ${label}: ${stderr}`);
    },
  };
}

function sendFrame(child, frame) {
  if (!child?.stdin?.writable) return;
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

async function requiredExecutable(name) {
  const candidate = path.resolve(requiredValue(name));
  try {
    await access(candidate, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new Error(`${name} must name a readable executable file.`);
  }
  return candidate;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
