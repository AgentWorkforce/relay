/**
 * relay#1671 — a remote fleet release could surface only "Internal server
 * error" and leave a harness descendant behind after the wrapper exited.
 *
 * The PR-proof runner executes once in each of two fresh Daytona sandboxes:
 * one exact base checkout and one exact head checkout. It executes the sealed
 * broker artifact from that checkout, then inspects only production source
 * markers and runs the head-only process-group regression test. No production
 * credentials, shared broker, or mutable external roster are involved.
 *
 * This is intentionally a two-arm cleanroom lane rather than a mock Relaycast
 * server. Relaycast completion owns the roster mutation; the broker contract
 * that makes a successful completion truthful is locally deterministic:
 * preserve the cause/correlation, terminate the entire worker group, and only
 * emit success after fleet deregistration has been queued/pruned. The actual
 * live two-node invocation remains covered by the cloud fleet E2E lane.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1671-fleet-release-absence';
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
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

// The artifact is opened and protected by run-arm.mjs. Running --help binds
// this observation to the same verified executable rather than merely proving
// that source text exists in the checkout.
const help = spawnSync(binaryPath, ['--help'], {
  cwd: targetDir,
  encoding: 'utf8',
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024,
});
if (help.error || help.status !== 0 || !`${help.stdout ?? ''}${help.stderr ?? ''}`.includes('agent-relay')) {
  throw new Error(`verified broker artifact did not execute --help: ${help.error?.message ?? help.stderr}`);
}

const fleet = await readFile(path.join(targetDir, 'crates/broker/src/runtime/fleet.rs'), 'utf8');
const events = await readFile(
  path.join(targetDir, 'crates/broker/src/runtime/relaycast_events.rs'),
  'utf8'
);
const spawner = await readFile(path.join(targetDir, 'crates/broker/src/spawner.rs'), 'utf8');
const worker = await readFile(path.join(targetDir, 'crates/broker/src/worker.rs'), 'utf8');

const typedFailure =
  /ReleaseOutcome::Failed\s*\{\s*error/.test(fleet) &&
  /release_action_failure[\s\S]*invocation_id/.test(fleet) &&
  /ReleaseOutcome::Failed\s*\{\s*error:\s*message/.test(events);
const processGroupTeardown =
  /fn signal_process_group\s*\(/.test(spawner) &&
  /signal_process_group\(pid, Signal::SIGTERM\)/.test(spawner) &&
  /signal_process_group\(pid, Signal::SIGKILL\)/.test(spawner) &&
  /command\.pre_exec\(\|\|\s*\{[\s\S]*?setsid\(\)/.test(worker);
const rosterReconcile =
  /deregister_fleet_agent\([\s\S]*?prune_fleet_agent_state/.test(fleet) &&
  /release_action_failure\(\s*"release_deregistration_failed"/.test(fleet);

if (arm === 'base') {
  if (typedFailure || processGroupTeardown || rosterReconcile) {
    throw new Error(
      `base unexpectedly contains the release fix: ${JSON.stringify({
        typedFailure,
        processGroupTeardown,
        rosterReconcile,
      })}`
    );
  }
  await observe('fleet_release_can_drop_cause_and_strand_descendants', 'bug',
    'The base action wire collapses release failures to bare release_failed and worker teardown has no private process-group guarantee.');
} else {
  if (!typedFailure || !processGroupTeardown || !rosterReconcile) {
    throw new Error(
      `head is missing a release absence guarantee: ${JSON.stringify({
        typedFailure,
        processGroupTeardown,
        rosterReconcile,
      })}`
    );
  }

  // This is the actual deterministic descendant proof shipped with the
  // broker package: it starts a wrapper plus child, releases it, and asserts
  // both the wrapper PID and its process group are gone.
  const test = spawnSync(
    'cargo',
    [
      'test',
      '--manifest-path',
      path.join(targetDir, 'Cargo.toml'),
      '-p',
      'agent-relay-broker',
      'release_terminates_the_worker_process_group',
      '--',
      '--quiet',
    ],
    { cwd: targetDir, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
  );
  if (test.error || test.status !== 0 || !`${test.stdout ?? ''}${test.stderr ?? ''}`.includes('1 passed')) {
    throw new Error(`head process-group proof failed: ${test.error?.message ?? `${test.stdout}\n${test.stderr}`}`);
  }
  await observe(
    'fleet_release_reports_cause_and_proves_absence',
    'fixed',
    'The verified head broker correlates failure code, worker, node, and invocation; tears down the complete process group; and reports success only after deregistration/pruning is queued.'
  );
}

async function observe(signature, outcome, details) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
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
  await access(candidate, fsConstants.R_OK | fsConstants.X_OK);
  return candidate;
}

function isWithin(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
