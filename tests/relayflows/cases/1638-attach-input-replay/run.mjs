import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1638-attach-input-replay';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
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

const probePath = path.join(
  targetDir,
  'packages/cli/src/cli/lib/.relayflow-1638-attach-input-replay.test.ts'
);
const probeObservationPath = path.join(targetDir, '.relayflow-1638-attach-input-replay-observation.json');
const probeConfigPath = path.join(targetDir, '.relayflow-1638-attach-input-replay.vitest.config.mjs');

const probeSource = String.raw`import { test } from 'vitest';
import { writeFile } from 'node:fs/promises';

import { createInputStreamRecovery } from './attach-input-recovery.js';

class FakeStream {
  closed = false;
  writes = [];

  async waitUntilOpen() {}

  async send(data) {
    if (this.closed) throw new Error('PTY input stream is closed');
    this.writes.push(data);
    return { name: 'proof-agent', bytes_written: Buffer.byteLength(data, 'utf8') };
  }

  close() {
    this.closed = true;
  }
}

async function observeRecovery(identityMatches, input) {
  let current = new FakeStream();
  const opened = [];
  const logs = [];
  const errors = [];
  let exhausted = 0;
  const recovery = createInputStreamRecovery({
    label: 'drive',
    name: 'proof-agent',
    maxAttempts: 1,
    baseDelayMs: 1,
    attemptTimeoutMs: 100,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    isSettled: () => false,
    getStream: () => current,
    setStream: (stream) => {
      current = stream;
    },
    openStream: () => {
      const stream = new FakeStream();
      opened.push(stream);
      return stream;
    },
    onRollback: () => {},
    onExhausted: () => {
      exhausted += 1;
    },
    verifyIdentity: async () =>
      identityMatches ? { ok: true } : { ok: false, reason: 'worker process changed' },
  });

  // The head implementation accepts the second argument and buffers it. The
  // base implementation ignores that JavaScript argument and drops the input.
  recovery.recover('stream closed', input);
  const deadline = Date.now() + 2_000;
  while (recovery.isRecovering() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (recovery.isRecovering()) throw new Error('Recovery did not settle before the probe deadline.');

  return {
    writes: opened.flatMap((stream) => stream.writes).join(''),
    logs,
    errors,
    exhausted,
  };
}

test('observes verified replay and rejected-identity discard through production recovery', async () => {
  const observationPath = process.env.RELAY_PR1638_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1638_OBSERVATION_PATH.');

  const accepted = await observeRecovery(true, 'typed during outage');
  const rejected = await observeRecovery(false, 'private command');
  await writeFile(observationPath, JSON.stringify({ accepted, rejected }), 'utf8');
});
`;

const probeConfigSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cli/src/cli/lib/.relayflow-1638-attach-input-replay.test.ts'],
    setupFiles: [],
  },
};\n`;

try {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation');
  await writeGeneratedFile(probePath, probeSource);
  await writeGeneratedFile(probeConfigPath, probeConfigSource);
  run(
    'npm',
    ['exec', '--', 'vitest', 'run', '--config', path.relative(targetDir, probeConfigPath)],
    targetDir,
    'attach input replay probe',
    { RELAY_PR1638_OBSERVATION_PATH: probeObservationPath }
  );

  const observation = JSON.parse(await readFile(probeObservationPath, 'utf8'));
  const acceptedWrites = observation.accepted?.writes;
  const rejectedWrites = observation.rejected?.writes;
  const rejectedErrors = Array.isArray(observation.rejected?.errors)
    ? observation.rejected.errors.join('\n')
    : '';
  const baseObserved =
    acceptedWrites === '' && rejectedWrites === '' && !rejectedErrors.includes('Discarded 15 buffered bytes');
  const headObserved =
    acceptedWrites === 'typed during outage' &&
    rejectedWrites === '' &&
    rejectedErrors.includes('Discarded 15 buffered bytes');

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'verified_attach_outage_input_dropped';
    details =
      'The base recovery adopted the verified replacement but forwarded zero outage bytes and reported no rejected-identity discard count.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'verified_attach_outage_input_replayed';
    details =
      'The head recovery replayed all 19 outage bytes after a positive identity verdict and forwarded zero bytes after a negative verdict, reporting all 15 discarded bytes.';
  } else {
    throw new Error(`Unexpected attach replay observation: ${JSON.stringify(observation)}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  await rm(probePath, { force: true });
  await rm(probeConfigPath, { force: true });
  await rm(probeObservationPath, { force: true });
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

async function writeGeneratedFile(targetPath, source) {
  try {
    const existing = await lstat(targetPath);
    if (!existing.isFile()) {
      throw new Error(`Refusing to replace non-regular generated file ${targetPath}.`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(source, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function run(command, args, cwd, label, extraEnv = {}) {
  const completed = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${
        completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status ?? 'unknown'}`
      }.`
    );
  }
}
