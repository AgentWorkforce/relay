import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This hosted case is deterministic and non-credentialed. The trusted
// qualification campaign performs live provider/node/agent rereads; this
// red/green proof only exercises exact candidate CLI semantics.
const CASE_ID = '1665-immutable-fleet-snapshot';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const CLI_TIMEOUT_MS = 120_000;
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
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
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const cliPath = path.join(targetDir, 'packages/cli/dist/cli/index.js');
if (!(await exists(cliPath))) {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation', buildEnvironment());
  run('npm', ['run', 'build:core'], targetDir, 'production CLI build', buildEnvironment());
}

const help = runNode(
  [cliPath, 'fleet', 'spawn', 'codex', '--help'],
  targetDir,
  buildEnvironment(),
  CLI_TIMEOUT_MS
);
if (help.status !== 0) {
  throw new Error(`current Fleet CLI help failed: ${tail(help.stderr || help.stdout)}`);
}
const helpText = `${help.stdout}\n${help.stderr}`;
for (const option of ['--sandbox', '--sandbox-provider', '--sandbox-id', '--workspace-id']) {
  if (!helpText.includes(option)) throw new Error(`current Fleet CLI help is missing ${option}`);
}
for (const removed of ['--sandbox-snapshot', '--sandbox-snapshot-manifest-sha256']) {
  if (helpText.includes(removed)) throw new Error(`removed Fleet CLI option returned: ${removed}`);
}

if (arm === 'base') {
  await writeObservation(
    'absent',
    'legacy_snapshot_argv_absent',
    'The exact target CLI exposes explicit workspace/sandbox identity controls and no removed snapshot argv flags.'
  );
} else {
  await writeObservation(
    'fixed',
    'fleet_cli_identity_controls',
    `Exact candidate CLI help proved explicit workspace/sandbox identity controls and rejected legacy snapshot flags; raw help output hash=${rawDigest('fleet-spawn-help', helpText).sha256}.`
  );
}

function rawDigest(label, text) {
  const bytes = Buffer.from(String(text));
  return { label, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function writeObservation(outcome, signature, details) {
  const observation = {
    version: 1,
    caseId: CASE_ID,
    arm,
    outcome,
    signature,
    details: details.slice(0, 4_000),
  };
  await writeFile(resultPath, `${JSON.stringify(observation)}\n`, { mode: 0o600 });
}

function run(command, args, cwd, label, env, timeout = COMMAND_TIMEOUT_MS) {
  const completed = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  return {
    ...completed,
    status: completed.status ?? 1,
    stdout: completed.stdout ?? '',
    stderr: completed.stderr ?? '',
  };
}

function runNode(args, cwd, env, timeout) {
  return run(process.execPath, args, cwd, 'CLI invocation', env, timeout);
}

function buildEnvironment() {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'CI',
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function tail(text) {
  return String(text ?? '').slice(-2_000);
}
