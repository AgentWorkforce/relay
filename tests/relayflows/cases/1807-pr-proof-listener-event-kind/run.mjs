#!/usr/bin/env node

/**
 * Proof for PR #1807: the hosted `relay.ci.pr-proof` listener's first step
 * accepts the event names Cloud actually delivers.
 *
 * Cloud names a delivery `pull_request.<action>`. Base requires the type to be
 * exactly `pull_request`, so the real delivery is refused as a deployment
 * misconfiguration and every hosted run dies at step one — `bug`.
 *
 * Head accepts `pull_request.synchronize` and writes the event file; skips
 * `pull_request.labeled` without writing anything; and still refuses
 * `issues.labeled` — a foreign kind whose action is also unlisted, which a
 * fix that filtered actions before checking the kind would have skipped as a
 * success — `fixed`.
 *
 * Self-contained: it runs only the target checkout's own
 * `scripts/pr-proof/event-from-input.mjs` (Node built-ins only) with the
 * delivery shapes under proof. No Cloud, no broker, no credentials.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1807-pr-proof-listener-event-kind';
const SCRIPT = 'scripts/pr-proof/event-from-input.mjs';
const COMMAND_TIMEOUT_MS = 60_000;
const PR = 1807;

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function requiredDirectory(name) {
  const value = requiredValue(name);
  if (!existsSync(value)) throw new Error(`${name} does not exist: ${value}`);
  return path.resolve(value);
}

const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = path.resolve(requiredValue('RELAY_PR_PROOF_RESULT_PATH'));
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: COMMAND_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!runnerPath.startsWith(`${harnessDir}${path.sep}`)) {
  throw new Error('The case runner must execute from the exact-head harness checkout.');
}

/** The envelope the hosted listener hands the flow, as `f.run` base64-encodes it. */
function delivery(type) {
  const input = { approver: 'proof-approver', event: { type, payload: { pull_request: { number: PR } } } };
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
}

function runScript(type, outPath) {
  const result = spawnSync(process.execPath, [SCRIPT, '--input-base64', delivery(type), '--out', outPath], {
    cwd: targetDir,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim().split('\n').at(-1) ?? '',
  };
}

let outcome;
let signature;
let details;

const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-pr1807-'));
try {
  if (!existsSync(path.join(targetDir, SCRIPT))) throw new Error(`Target is missing ${SCRIPT}.`);

  // The delivery every hosted run actually received.
  const realOut = path.join(scratch, 'real.json');
  const real = runScript('pull_request.synchronize', realOut);

  if (arm === 'base') {
    if (real.status === 0 || existsSync(realOut)) {
      throw new Error(`Base unexpectedly accepted pull_request.synchronize: ${real.stdout}`);
    }
    if (!real.stderr.includes('"pull_request.synchronize"')) {
      throw new Error(`Base failed for a reason other than the event name: ${real.stderr}`);
    }
    outcome = 'bug';
    signature = 'listener_pull_request_delivery_rejected';
    details =
      `In the exact base checkout, ${SCRIPT} exits ${real.status} on a pull_request.synchronize delivery ` +
      `and writes no event file: ${real.stderr}. That is the listener's first step, so no hosted proof can start.`;
  } else {
    if (real.status !== 0 || !existsSync(realOut)) {
      throw new Error(`Head refused pull_request.synchronize: ${real.stderr || real.stdout}`);
    }
    const written = JSON.parse(await readFile(realOut, 'utf8'));
    if (written?.inputs?.pr_number !== PR) {
      throw new Error(`Head wrote the wrong event: ${JSON.stringify(written)}`);
    }

    // An action the proof has no opinion about: succeed, say so, write nothing.
    const skipOut = path.join(scratch, 'skip.json');
    const skipped = runScript('pull_request.labeled', skipOut);
    if (skipped.status !== 0 || !skipped.stdout.includes('PR_PROOF_EVENT_SKIPPED action=labeled')) {
      throw new Error(`Head did not skip pull_request.labeled: ${skipped.stderr || skipped.stdout}`);
    }
    if (existsSync(skipOut)) throw new Error('Head wrote an event file for a skipped delivery.');

    // A foreign kind with an unlisted action must still fail loudly; a fix
    // that filtered actions first would report this misconfiguration as success.
    const foreignOut = path.join(scratch, 'foreign.json');
    const foreign = runScript('issues.labeled', foreignOut);
    if (foreign.status === 0 || existsSync(foreignOut) || foreign.stdout.includes('PR_PROOF_EVENT_SKIPPED')) {
      throw new Error(`Head accepted or skipped a foreign issues.labeled delivery: ${foreign.stdout}`);
    }
    if (!foreign.stderr.includes('"issues.labeled"')) {
      throw new Error(`Head refused issues.labeled for the wrong reason: ${foreign.stderr}`);
    }

    outcome = 'fixed';
    signature = 'listener_pull_request_delivery_accepted_foreign_rejected';
    details =
      `In the exact head checkout, ${SCRIPT} accepts pull_request.synchronize and writes pr_number ${PR}; ` +
      'skips pull_request.labeled (exit 0, PR_PROOF_EVENT_SKIPPED, no file); and still refuses ' +
      `issues.labeled (exit ${foreign.status}, no file), so a foreign delivery cannot pass as a skipped success.`;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`
);
console.log(`PR1807_CASE_COMPLETE arm=${arm} outcome=${outcome} signature=${signature}`);
