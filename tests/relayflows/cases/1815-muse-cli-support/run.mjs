#!/usr/bin/env node

/**
 * Red/green proof for first-class Muse spawning.
 *
 * The exact base must not advertise Muse. The exact head must register the
 * harness, pace prompt submission with a distinct Enter, and provision an
 * isolated Muse settings file for Relay MCP. The head arm also runs the
 * focused Rust tests that exercise those production helpers.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1815-muse-cli-support';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const targetDir = path.resolve(requiredValue('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(requiredValue('RELAY_PR_PROOF_HARNESS_DIR'));
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
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const [harnesses, worker, snippets, wrap] = await Promise.all([
  readFile(path.join(targetDir, 'packages/harnesses/src/index.ts'), 'utf8'),
  readFile(path.join(targetDir, 'crates/broker/src/worker.rs'), 'utf8'),
  readFile(path.join(targetDir, 'crates/broker/src/snippets.rs'), 'utf8'),
  readFile(path.join(targetDir, 'crates/broker/src/wrap.rs'), 'utf8'),
]);

const baseObserved =
  !harnesses.includes("command: 'muse'") &&
  !worker.includes('muse_config_home_for_worker') &&
  !snippets.includes('ensure_muse_mcp_config');

const headObserved =
  harnesses.includes("command: 'muse'") &&
  worker.includes('muse_config_home_for_worker') &&
  snippets.includes('ensure_muse_mcp_config') &&
  wrap.includes('paste_submit_harness') &&
  wrap.includes('"muse"');

let outcome;
let signature;
let details;
if (baseObserved) {
  outcome = 'absent';
  signature = 'muse_spawn_support_absent';
  details = 'The exact base does not register Muse or provision a Muse Relay MCP config home.';
} else if (headObserved) {
  execFileSync('cargo', ['test', '-p', 'agent-relay-broker', 'muse', '--lib'], {
    cwd: targetDir,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: COMMAND_TIMEOUT_MS,
  });
  outcome = 'fixed';
  signature = 'muse_spawn_injection_and_relay_mcp_ready';
  details =
    'The exact head registers Muse, submits prompts with the paced PTY path, provisions an isolated Relay MCP settings home, and passes the focused broker tests.';
} else {
  throw new Error(
    'Unexpected partial Muse support: registration, injection, and MCP provisioning must move together.'
  );
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`,
  'utf8'
);

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
