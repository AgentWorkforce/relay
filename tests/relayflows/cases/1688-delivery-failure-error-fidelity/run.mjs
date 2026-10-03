// RelayFlow proof case 1688-delivery-failure-error-fidelity.
//
// THE BUG (present on base, fixed on head)
//
// When a delivery exhausts its retry cap, the broker emits a terminal
// `message_delivery_failed` event carrying `lastError`. That field is the only
// machine-readable account of WHY the delivery died: it is what reaches the
// dead-letter store, `/health` consumers and the orchestrator. On base the
// broker's own suite only asserted that `lastError` *contains* an expected
// fragment, so an error that had been wrapped or substituted somewhere in the
// write path still satisfied it. A terminal event could therefore report a
// different error than the one that actually killed the delivery, and nothing
// in the suite would notice. Head compares the value exactly.
//
// WHY THIS CASE IS SHAPED AS MUTATION DETECTION
//
// `crates/broker/src/runtime/tests.rs` is behind `#[cfg(test)]`
// (`crates/broker/src/runtime/mod.rs:89`), so it is compiled out of the shipped
// broker. Base and head therefore produce functionally identical broker
// binaries, and no case that merely RUNS the broker can distinguish them —
// running one would prove nothing about this change no matter what it observed.
// The honest observable is the suite's detection power, so both arms inject the
// same defect into the write path and ask the target's own test whether it
// notices.
//
// The injected defect is faithful to the bug, not a strawman: the message still
// CONTAINS the expected fragment and only stops being EQUAL to it. That is
// precisely the class base could not see.
//
// FAIL-CLOSED
//
// Only two outcomes are evidence: the target's test passing with the defect
// live (bug), or failing on that exact comparison (fixed). A compile error, a
// missing toolchain, a failure at any other assertion, or an unparseable run
// throws instead — a crash must never be laundered into a proof.

import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CASE_ID = '1688-delivery-failure-error-fidelity';
const TEST_NAME = 'runtime::tests::delivery_retry_transient_blip_emits_failed_event_for_present_worker';
// The context applied to every broker->worker write failure. All three sites
// must be rewritten: base surfaces this error from the completion path and head
// from the queue-send path, so mutating only one would leave the defect inert on
// one arm and the comparison would be meaningless.
const WRITE_ERROR_CONTEXT = `format!("failed writing frame to worker '{name}'")`;
const WRAPPED_WRITE_ERROR_CONTEXT = `format!("failed writing frame to worker '{name}' (queue closed)")`;
const EXPECTED_CONTEXT_SITES = 3;
const DETECTION_MARKER = 'the terminal event must carry the real write error verbatim';

const arm = required('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}
const targetDir = required('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = required('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');

// Provenance: the code under test must be the exact SHA for this arm, and this
// script must be the one committed to the PR head, not one found in the target.
const expectedSha =
  arm === 'base' ? required('RELAY_PR_PROOF_BASE_SHA') : required('RELAY_PR_PROOF_HEAD_SHA');
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}
const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The case runner must execute from the exact-head harness checkout.');
}

const workerPath = path.join(targetDir, 'crates', 'broker', 'src', 'worker.rs');
const original = await readFile(workerPath, 'utf8');
const sites = original.split(WRITE_ERROR_CONTEXT).length - 1;
if (sites !== EXPECTED_CONTEXT_SITES) {
  throw new Error(
    `Expected ${EXPECTED_CONTEXT_SITES} write-error context sites in worker.rs, found ${sites}. ` +
      'The defect could not be injected identically on both arms, so this run is not evidence.'
  );
}
await writeFile(workerPath, original.split(WRITE_ERROR_CONTEXT).join(WRAPPED_WRITE_ERROR_CONTEXT), 'utf8');

const run = await runTest();
const { outcome, signature, details } = classify(run);

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
  'utf8'
);

async function runTest() {
  try {
    const { stdout, stderr } = await execFileAsync(
      'cargo',
      ['test', '-p', 'agent-relay-broker', '--lib', TEST_NAME, '--', '--exact'],
      {
        cwd: targetDir,
        env: { ...process.env, AGENT_RELAY_TELEMETRY_DISABLED: '1', CARGO_TERM_COLOR: 'never' },
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    if (typeof error.code !== 'number') {
      throw new Error(`cargo test could not be run (${error.code ?? error.message}).`);
    }
    return { exitCode: error.code, output: `${error.stdout ?? ''}\n${error.stderr ?? ''}` };
  }
}

function classify({ exitCode, output }) {
  const ran = /^running \d+ tests?$/m.test(output);
  if (!ran) {
    throw new Error(`The target's test never ran, so nothing was observed. Tail:\n${output.slice(-1500)}`);
  }
  if (exitCode === 0) {
    if (!/test result: ok\. 1 passed; 0 failed/.test(output)) {
      throw new Error(`Unrecognised passing summary. Tail:\n${output.slice(-1500)}`);
    }
    return {
      outcome: 'bug',
      signature: 'wrapped_delivery_error_undetected',
      details:
        'With a wrapped lastError live in every broker->worker write path, the target suite ' +
        'still passed: a terminal message_delivery_failed event may report an error other ' +
        'than the one that killed the delivery, undetected.',
    };
  }
  if (!output.includes(DETECTION_MARKER)) {
    throw new Error(
      `The test failed, but not on the terminal lastError comparison, so this is not evidence ` +
        `of the declared fix. Tail:\n${output.slice(-1500)}`
    );
  }
  return {
    outcome: 'fixed',
    signature: 'wrapped_delivery_error_detected',
    details:
      'The same wrapped lastError is now caught: the target suite fails on the exact ' +
      'comparison of the terminal message_delivery_failed error, so a wrapped or substituted ' +
      'write error can no longer reach the wire unnoticed.',
  };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
