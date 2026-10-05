#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1891-codex-parked-composer-recovery';
const BODY = 'RELAY_1891_PARKED_COMPOSER_SENTINEL\nComplete the requested task exactly once.';
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = await requiredExecutable('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') throw new Error(`Unexpected proof arm ${JSON.stringify(arm)}.`);
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (targetSha !== expectedSha)
  throw new Error(`Target checkout ${targetSha} does not match ${arm} SHA ${expectedSha}.`);
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1891-'));
const binDir = path.join(probeDir, 'bin');
const fakeCodexPath = path.join(binDir, 'codex');
const fakeCodexSource = String.raw`#!/usr/bin/env node
const sentinel = ${JSON.stringify(BODY)};
process.stdin.setRawMode?.(true);
process.stdin.resume();
// The placeholder is transcript text; Codex's actual idle composer is an
// empty prompt with its cursor immediately after "› ". That cursor placement
// is what the broker's startup gate must see before it emits worker_ready.
process.stdout.write('Welcome to Codex\r\nAsk Codex to do anything\r\n› ');

let composer = '';
let parked = false;
let sawEnd = false;
let submitted = false;
let copies = 0;
let escape = [];

function park() {
  parked = true;
  // Reflow the envelope like the native Codex TUI. The raw PTY output cannot
  // match the original formatted body byte-for-byte, while the exact compact
  // tail remains visible in the live composer.
  process.stdout.write('\r\n' + composer.replaceAll('\n', '\r\n  ') + '\r\nCOMPOSER_PARKED\r\n› ' + composer.replace(/\s+/g, '').slice(-96));
}

function submit() {
  submitted = true;
  composer = '';
  process.stdout.write('\x1b[2J\x1b[HWorking (1s · esc to interrupt)\r\nTASK_STARTED copies=' + copies + '\r\n');
}

function receiveByte(byte) {
  if (escape.length > 0) {
    escape.push(byte);
    if (escape.length === 3) {
      if (escape[0] === 0x1b && escape[1] === 0x5b && escape[2] === 0x46) sawEnd = true;
      escape = [];
    }
    return;
  }
  if (byte === 0x1b) {
    escape = [byte];
    return;
  }
  if (byte === 13) {
    if (!parked && composer.includes(sentinel)) {
      park();
    } else if (parked && sawEnd && !submitted) {
      submit();
    }
    return;
  }
  // A Relay envelope is multiline. Codex keeps pasted LFs in the composer;
  // retaining them lets the fixture recognize the exact delivery body rather
  // than a flattened approximation.
  if (byte === 10) {
    composer += '\n';
    return;
  }
  composer += String.fromCharCode(byte);
  if (composer.endsWith(sentinel)) copies += 1;
}

process.stdin.on('data', (chunk) => {
  for (const byte of chunk) receiveByte(byte);
});

setTimeout(() => {
  if (!submitted) process.stdout.write('\r\nTASK_PARKED_TIMEOUT copies=' + copies + '\r\n');
}, 12_000).unref();
`;

let worker;
let stderr = '';
try {
  await mkdir(binDir, { recursive: true });
  await writeFile(fakeCodexPath, fakeCodexSource, { encoding: 'utf8', mode: 0o700 });
  await chmod(fakeCodexPath, 0o700);
  worker = spawn(binaryPath, ['pty', '--agent-name', 'relayflow-codex-1891', 'codex'], {
    cwd: targetDir,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:LD_|DYLD_)/.test(name))),
      PATH: `${binDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      RELAY_INJECT_RATE_MS: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  const frames = createFrameQueue(worker, () => stderr);
  sendFrame(worker, { v: 2, type: 'init_worker', payload: { agent: { name: 'relayflow-codex-1891' } } });
  await frames.waitFor((frame) => frame.type === 'worker_ready', 15_000, 'worker readiness');
  sendFrame(worker, {
    v: 2,
    type: 'deliver_relay',
    request_id: 'relayflow-delivery',
    payload: {
      delivery_id: 'delivery_relayflow_1891',
      event_id: 'event_relayflow_1891',
      from: 'broker',
      target: 'relayflow-codex-1891',
      body: BODY,
      priority: 2,
      injection_mode: 'wait',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  sendFrame(worker, {
    v: 2,
    type: 'snapshot_pty',
    request_id: 'parked-snapshot',
    payload: { format: 'plain' },
  });
  const parkedSnapshot = await frames.waitFor(
    (frame) => frame.type === 'snapshot_response' && frame.request_id === 'parked-snapshot',
    5_000,
    'parked Codex snapshot'
  );
  const taskObserver = createTaskObserver();
  let observation;
  await frames.waitFor(
    (frame) => {
      observation = taskObserver.observe(frame);
      return observation !== undefined;
    },
    20_000,
    'parked or submitted task marker'
  );
  let outcome;
  let signature;
  let details;
  if (arm === 'base' && observation.marker === 'TASK_PARKED_TIMEOUT' && observation.copies === 1) {
    outcome = 'bug';
    signature = 'codex_delivery_left_in_composer';
    details = `The delivery body reached the Codex composer ${observation.copies} time without a turn; the baseline never sent the bounded submit-only recovery.`;
  } else if (arm === 'head' && observation.marker === 'TASK_STARTED' && observation.copies === 1) {
    outcome = 'fixed';
    signature = 'codex_parked_delivery_recovers_once';
    details =
      'The body remained parked, then the broker sent End plus a distinct submit key; Codex accepted one turn without replaying the body.';
  } else {
    throw new Error(
      `Unexpected parked-composer outcome ${JSON.stringify({ arm, observation, parkedSnapshot: parkedSnapshot.payload, frames: frames.debugSummary() })}.`
    );
  }
  if (arm === 'head') {
    const settlement = await frames.waitFor(
      (frame) => frame.type === 'delivery_verified' || frame.type === 'delivery_failed',
      35_000,
      'broker acceptance of the submitted Codex turn'
    );
    if (settlement.type !== 'delivery_verified') {
      throw new Error(
        `Codex started the turn but broker rejected delivery: ${JSON.stringify(settlement.payload)}.`
      );
    }
    if (frames.count('delivery_injected') !== 1 || frames.count('delivery_resubmitted') !== 1) {
      throw new Error(
        `Expected one body write and one submit-only recovery: ${JSON.stringify(frames.debugSummary())}.`
      );
    }
  }
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  if (worker?.exitCode === null) {
    sendFrame(worker, { v: 2, type: 'shutdown_worker', payload: { reason: 'proof complete' } });
    await Promise.race([
      new Promise((resolve) => worker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  await rm(probeDir, { recursive: true, force: true });
}

function createTaskObserver() {
  let output = '';
  const seen = new WeakSet();
  return {
    observe(frame) {
      if (frame?.type !== 'worker_stream' || typeof frame.payload?.chunk !== 'string') return undefined;
      // waitFor can revisit queued frames on each poll. Each stream chunk must
      // contribute to the split-marker buffer exactly once.
      if (seen.has(frame)) return undefined;
      seen.add(frame);
      // The broker may split terminal output across stream frames. Keep a
      // bounded tail so a marker is recognized even when it crosses a frame.
      output = `${output}${frame.payload.chunk}`.slice(-8_000);
      const match = /\b(TASK_(?:STARTED|PARKED_TIMEOUT)) copies=(\d+)\b/.exec(output);
      return match ? { marker: match[1], copies: Number(match[2]) } : undefined;
    },
  };
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
      if (recent.length > 20) recent.shift();
    } catch (error) {
      parseError = new Error(`Broker emitted invalid JSON: ${error.message}; line=${line.slice(0, 2_000)}`);
    }
    for (const notify of waiters) notify();
  });
  child.once('exit', (code, signal) => {
    exitError = new Error(
      `Broker exited before proof completed (${signal ?? code ?? 'unknown'}): ${getStderr()}`
    );
    for (const notify of waiters) notify();
  });
  return {
    count(type) {
      return counts.get(type) ?? 0;
    },
    debugSummary() {
      return { counts: Object.fromEntries(counts), recent };
    },
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
      throw new Error(`Timed out waiting for ${label}: ${getStderr()}`);
    },
  };
}

function sendFrame(child, frame) {
  if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify(frame)}\n`);
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
