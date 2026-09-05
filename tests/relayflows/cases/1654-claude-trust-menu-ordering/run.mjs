import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createTrustObserver } from './trust-observation.mjs';

const CASE_ID = '1654-claude-trust-menu-ordering';
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

// Deterministic model of Claude Code's folder-trust dialog.
//
// Both orderings are real, captured from live PTY spawns on 2026-09-05:
//   legacy (2.1.236) -> "❯1.Yes,Itrustthisfolder" / "2.No,exit"
//   modern (2.1.261) -> "❯No,exit"                / "Yes,Itrustthisfolder"
//
// Claude paints the dialog with cursor-positioning escapes rather than literal
// spaces, so the first frame arrives with inter-word spacing collapsed. The
// model reproduces that byte shape, because collapsing is exactly what makes a
// naive label match fail.
const fakeClaudeSource = String.raw`#!/usr/bin/env node
const layout = process.env.RELAY_PROOF_TRUST_LAYOUT;
const rows =
  layout === 'legacy'
    ? [
        { label: '1.Yes,Itrustthisfolder', affirmative: true },
        { label: '2.No,exit', affirmative: false },
      ]
    : [
        { label: 'No,exit', affirmative: false },
        { label: 'Yes,Itrustthisfolder', affirmative: true },
      ];

// Both real layouts open with the highlight on the first row.
let selected = 0;
let decided = false;

function render() {
  let frame = '\r\n';
  frame += 'Accessingworkspace:\r\n\r\n';
  frame += process.cwd() + '\r\n\r\n';
  frame += "Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\r\n";
  frame += "ClaudeCode'llbeabletoread,edit,andexecutefileshere.\r\n\r\n";
  for (let i = 0; i < rows.length; i += 1) {
    frame += (i === selected ? '❯' : '') + rows[i].label + '\r\n';
  }
  frame += '\r\nEntertoconfirm·Esctocancel\r\n';
  process.stdout.write(frame);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
render();

process.stdin.on('data', (chunk) => {
  const bytes = Array.from(chunk);
  for (let i = 0; i < bytes.length; i += 1) {
    if (decided) return;
    // CSI B (cursor down) / CSI A (cursor up)
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x5b && (bytes[i + 2] === 0x42 || bytes[i + 2] === 0x41)) {
      selected =
        bytes[i + 2] === 0x42
          ? Math.min(selected + 1, rows.length - 1)
          : Math.max(selected - 1, 0);
      i += 2;
      render();
      continue;
    }
    if (bytes[i] === 13) {
      decided = true;
      if (rows[selected].affirmative) {
        // Trusted: Claude proceeds to its main UI and stays available.
        process.stdout.write('\r\nTRUST_ACCEPTED layout=' + layout + '\r\n');
        process.stdout.write('Welcome back Relay!\r\n❯');
      } else {
        // "No, exit" confirmed: Claude terminates. This is the #1654 failure.
        process.stdout.write('\r\nTRUST_EXITED layout=' + layout + '\r\n');
        setTimeout(() => process.exit(0), 50);
      }
      return;
    }
  }
});
`;

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1654-'));
const binDir = path.join(probeDir, 'bin');
const fakeClaudePath = path.join(binDir, 'claude');

const observations = {};
try {
  await mkdir(binDir, { recursive: true });
  await writeFile(fakeClaudePath, fakeClaudeSource, { encoding: 'utf8', mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);

  // Both orderings are exercised on every arm. A change that fixes the modern
  // layout by unconditionally stepping the highlight would break the legacy
  // layout, and must not be able to report success here.
  for (const layout of ['modern', 'legacy']) {
    observations[layout] = await observeTrustDialog(layout);
  }

  const { outcome, signature, details } = classify(observations);

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  await rm(probeDir, { recursive: true, force: true });
}

function classify(results) {
  const modern = results.modern;
  const legacy = results.legacy;

  if (modern === 'ACCEPTED' && legacy === 'ACCEPTED') {
    return {
      outcome: 'fixed',
      signature: 'claude_trust_confirmed_affirmative_both_orderings',
      details:
        'The compiled broker resolved the affirmative row by label in both menu orderings: it stepped the highlight down one row in the 2.1.261 layout and confirmed in place in the 2.1.236 layout. Both deterministic Claude models reported TRUST_ACCEPTED and stayed alive.',
    };
  }

  if (modern === 'EXITED') {
    return {
      outcome: 'bug',
      signature: 'claude_trust_confirmed_exit',
      details: `The compiled broker pressed Enter without moving the highlight off the preselected "No, exit" row in the 2.1.261 layout; the deterministic Claude model reported TRUST_EXITED and terminated. Legacy layout observed: ${legacy}.`,
    };
  }

  throw new Error(
    `Unexpected trust outcomes ${JSON.stringify(results)}. A fix that regresses the legacy ordering must fail rather than report success.`
  );
}

async function observeTrustDialog(layout) {
  let stderr = '';
  let worker;
  try {
    worker = spawn(binaryPath, ['pty', '--agent-name', `relayflow-trust-${layout}`, 'claude'], {
      cwd: targetDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
        RELAY_INJECT_RATE_MS: '0',
        RELAY_PROOF_TRUST_LAYOUT: layout,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    worker.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });

    const frames = createFrameQueue(worker, () => stderr);
    sendFrame(worker, {
      v: 2,
      type: 'init_worker',
      payload: { agent: { name: `relayflow-trust-${layout}` } },
    });
    await frames.waitFor((frame) => frame.type === 'worker_ready', 15_000, 'worker readiness');

    const observer = createTrustObserver();
    let observation;
    await frames.waitFor(
      (frame) => {
        observation = observer.observe(frame);
        return observation !== undefined;
      },
      20_000,
      `trust decision marker (${layout} layout)`
    );

    if (observation.layout !== layout) {
      throw new Error(
        `Trust marker reported layout ${observation.layout}, expected ${layout}. The probe binary was misconfigured.`
      );
    }
    return observation.outcome;
  } finally {
    if (worker && worker.exitCode === null) {
      sendFrame(worker, { v: 2, type: 'shutdown_worker', payload: { reason: 'proof complete' } });
      await Promise.race([
        new Promise((resolve) => worker.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
  }
}

function createFrameQueue(child, readStderr) {
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
    exitError = new Error(
      `Broker exited before proof completed (${signal ?? code ?? 'unknown'}): ${readStderr()}`
    );
    for (const notify of waiters) notify();
  });

  return {
    async waitFor(predicate, timeoutMs, description) {
      const deadline = Date.now() + timeoutMs;
      let cursor = 0;
      for (;;) {
        if (parseError) throw parseError;
        while (cursor < queue.length) {
          const frame = queue[cursor];
          cursor += 1;
          if (predicate(frame)) return frame;
        }
        if (exitError) throw exitError;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.`);
        }
        await new Promise((resolve) => {
          const notify = () => {
            waiters.delete(notify);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(notify, Math.min(remaining, 250));
          waiters.add(notify);
        });
      }
    },
  };
}

function sendFrame(child, frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function requiredValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

async function requiredExecutable(name) {
  const value = path.resolve(requiredValue(name));
  await access(value, fsConstants.X_OK);
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
