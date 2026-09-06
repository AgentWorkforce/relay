import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseTrustDecision } from './trust-observation.mjs';

const CASE_ID = '1654-claude-trust-menu-ordering';
const DECISION_TIMEOUT_MS = 60_000;
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
//
// The decision is written to a file rather than announced on stdout: the
// broker's startup readiness gate rejects an onboarding menu, so the worker
// never reaches readiness until the dialog has been answered, and an
// observation that waited on the frame stream would time out on both arms.
const fakeClaudeSource = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const layout = process.env.RELAY_PROOF_TRUST_LAYOUT;
const decisionPath = process.env.RELAY_PROOF_TRUST_DECISION_PATH;
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
  frame += 'Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\r\n';
  frame += "ClaudeCode'llbeabletoread,edit,andexecutefileshere.\r\n\r\n";
  for (let i = 0; i < rows.length; i += 1) {
    frame += (i === selected ? '❯' : '') + rows[i].label + '\r\n';
  }
  frame += '\r\nEntertoconfirm·Esctocancel\r\n';
  process.stdout.write(frame);
}

// Written atomically so the runner can never read a half-written decision.
function recordDecision(line) {
  const tmp = decisionPath + '.partial';
  fs.writeFileSync(tmp, line + '\n');
  fs.renameSync(tmp, decisionPath);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
render();

process.stdin.on('data', (chunk) => {
  const bytes = Array.from(chunk);
  for (let i = 0; i < bytes.length; i += 1) {
    if (decided) return;
    // CSI B (cursor down) / CSI A (cursor up)
    if (
      bytes[i] === 0x1b &&
      bytes[i + 1] === 0x5b &&
      (bytes[i + 2] === 0x42 || bytes[i + 2] === 0x41)
    ) {
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
        recordDecision('TRUST_ACCEPTED layout=' + layout);
        // Trusted: Claude proceeds to its main UI and stays available. This
        // banner is also what lets the broker's readiness gate finally pass.
        process.stdout.write('\r\nWelcome back Relay!\r\n❯');
      } else {
        // "No, exit" confirmed: Claude terminates. This is the #1654 failure.
        recordDecision('TRUST_EXITED layout=' + layout);
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

  // Both orderings are exercised on every arm. A change that fixed the modern
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
        'The compiled broker resolved the affirmative row by label in both menu orderings: it stepped the highlight down one row in the 2.1.261 layout and confirmed in place in the 2.1.236 layout. Both deterministic Claude models recorded TRUST_ACCEPTED.',
    };
  }

  if (modern === 'EXITED') {
    return {
      outcome: 'bug',
      signature: 'claude_trust_confirmed_exit',
      details: `The compiled broker pressed Enter without moving the highlight off the preselected "No, exit" row in the 2.1.261 layout; the deterministic Claude model recorded TRUST_EXITED and terminated. Legacy layout observed: ${legacy}.`,
    };
  }

  throw new Error(
    `Unexpected trust outcomes ${JSON.stringify(results)}. A fix that regresses the legacy ordering must fail rather than report success.`
  );
}

async function observeTrustDialog(layout) {
  const decisionPath = path.join(probeDir, `decision-${layout}.txt`);
  let stderr = '';
  let worker;
  let exited;
  try {
    worker = spawn(binaryPath, ['pty', '--agent-name', `relayflow-trust-${layout}`, 'claude'], {
      cwd: targetDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
        RELAY_INJECT_RATE_MS: '0',
        RELAY_PROOF_TRUST_LAYOUT: layout,
        RELAY_PROOF_TRUST_DECISION_PATH: decisionPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    worker.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    worker.stdout.resume();
    worker.once('exit', (code, signal) => {
      exited = signal ?? code ?? 'unknown';
    });

    // Starting the worker is what spawns the child CLI. Readiness is
    // deliberately not awaited — see trust-observation.mjs.
    sendFrame(worker, {
      v: 2,
      type: 'init_worker',
      payload: { agent: { name: `relayflow-trust-${layout}` } },
    });

    const decision = await waitForDecision(decisionPath, layout, () => ({ exited, stderr }));
    if (decision.layout !== layout) {
      throw new Error(
        `Trust decision reported layout ${decision.layout}, expected ${layout}. The probe binary was misconfigured.`
      );
    }
    return decision.outcome;
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

async function waitForDecision(decisionPath, layout, diagnostics) {
  const deadline = Date.now() + DECISION_TIMEOUT_MS;
  for (;;) {
    let contents;
    try {
      contents = await readFile(decisionPath, 'utf8');
    } catch {
      contents = undefined;
    }
    const decision = parseTrustDecision(contents);
    if (decision) return decision;

    if (Date.now() >= deadline) {
      const { exited, stderr } = diagnostics();
      throw new Error(
        `Timed out after ${DECISION_TIMEOUT_MS}ms waiting for the ${layout} trust decision. ` +
          `Broker exit: ${exited ?? 'still running'}. Stderr: ${stderr || '(empty)'}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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
