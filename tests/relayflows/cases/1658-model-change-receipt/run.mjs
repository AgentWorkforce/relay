/**
 * relay#1658 — the model control command must expose a machine-readable
 * receipt. This contract probe is intentionally independent of a real
 * provider: PTY/native providers cannot truthfully claim application without
 * a typed acknowledgement, while the broker/runtime unit tests cover the
 * accepted → provider-confirmed applied path and stale fencing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1658-model-change-receipt';
const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}
const runnerPath = fileURLToPath(import.meta.url);
const relativeRunner = path.relative(path.resolve(harnessDir), path.resolve(runnerPath));
if (!relativeRunner || relativeRunner.startsWith('..') || path.isAbsolute(relativeRunner)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: targetDir,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, RELAY_SKIP_TELEMETRY: '1' },
  });
  if (result.error) throw new Error(`${label} failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status}: ${result.stderr ?? ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

try {
  // Build the CLI from the exact checkout so this probe cannot accidentally
  // execute a globally installed command or a stale dist tree.
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'dependency installation');
  for (const step of [
    'build:session',
    'build:config',
    'build:cloud',
    'build:utils',
    'build:policy',
    'build:sdk',
    'build:harness-driver',
    'build:harnesses',
    'build:fleet',
    'build:cli',
  ]) {
    run('npm', ['run', step], `${step} build`);
  }

  const cliEntry = path.join(targetDir, 'packages/cli/dist/cli/index.js');
  const help = run(process.execPath, [cliEntry, 'node', 'agent', 'set-model', '--help'], 'set-model help');
  const hasJson = /--json\b/.test(help);
  const outcome = hasJson ? 'fixed' : 'bug';
  const signature = hasJson ? 'set_model_exposes_json_receipt' : 'set_model_has_no_json_receipt';
  const details = hasJson
    ? 'The head CLI advertises --json for the correlated model receipt; provider application remains governed by typed runtime confirmation.'
    : 'The base CLI has no --json receipt surface, so callers cannot consume request/generation/effective model state.';
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  throw error;
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}
