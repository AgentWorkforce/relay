/**
 * RelayFlow proof for the mounted product CLI surfaces.
 *
 * The claim: `agent-relay` grows `file`, `flows`, and `sessions` groups that
 * hand a product's own CLI its argv untouched, and render help under the
 * `agent-relay` name rather than the product's.
 *
 * The probe mounts a *fake* surface rather than a real product SDK. That is
 * deliberate: the real SDKs only expose their `relay-cli` subpath once their own
 * releases land, so depending on them here would make this case prove the state
 * of the registry instead of the state of this repo. What is under test is the
 * mount — argv passthrough, help rendering, and unknown-command handling — and
 * a fake surface exercises exactly that.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1783-product-cli-surfaces';
const EXPECTED_GROUPS = ['file', 'flows', 'sessions'];
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

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

const probePath = path.join(targetDir, 'packages/cli/src/cli/.relayflow-1783-surfaces.test.ts');
const probeObservationPath = path.join(targetDir, '.relayflow-1783-surfaces-observation.json');
const probeConfigPath = path.join(targetDir, '.relayflow-1783-surfaces.vitest.config.mjs');

const probeSource = String.raw`import { writeFile } from 'node:fs/promises';

import { Command } from 'commander';
import { test } from 'vitest';

const observationPath = process.env.RELAY_PR1783_OBSERVATION_PATH;

/** A stand-in product CLI: one command, recording exactly what argv it got. */
function fakeSurface(received) {
  return {
    id: 'proof-product',
    version: '0.0.0',
    contract: 1,
    commands: [{ name: 'probe-command', description: 'Proof command' }],
    run: async (argv) => {
      received.push([...argv]);
      return 0;
    },
  };
}

test('observe the mounted product surfaces', async () => {
  // Which top-level groups the CLI registers at all.
  let registeredGroups = [];
  let programError = null;
  try {
    const { createProgram } = await import('./bootstrap.js');
    registeredGroups = createProgram()
      .commands.map((command) => command.name())
      .sort();
  } catch (error) {
    programError = error instanceof Error ? error.message : String(error);
  }

  // Whether the mount exists and behaves.
  let mountAvailable = false;
  let forwardedArgv = null;
  let helpUsageLine = null;
  let unknownCommandExitCode = null;
  let mountError = null;

  try {
    const surfaces = await import('./commands/product-surfaces.js');
    mountAvailable = typeof surfaces.registerProductSurfaceCommands === 'function';

    if (mountAvailable) {
      const received = [];
      const out = [];
      const err = [];
      let exitCode = null;
      const program = new Command('agent-relay');
      program.exitOverride();
      program.enablePositionalOptions();
      surfaces.registerProductSurfaceCommands(
        program,
        {
          importModule: async () => ({ createRelayCliSurface: () => fakeSurface(received) }),
          io: { stdout: (chunk) => out.push(String(chunk)), stderr: (chunk) => err.push(String(chunk)) },
          exit: (code) => {
            exitCode = code;
            throw new Error('proof-exit');
          },
        },
        [{ as: 'file', description: 'proof mount', specifier: 'proof://surface' }]
      );

      // Argv must reach the product verbatim, unknown flags included.
      await program.parseAsync(['file', 'probe-command', '--flag-the-host-never-heard-of', 'v'], {
        from: 'user',
      });
      forwardedArgv = received[0] ?? null;

      // Help must name agent-relay, not the product.
      out.length = 0;
      await program.parseAsync(['file', '--help'], { from: 'user' });
      helpUsageLine = (out.join('').split('\n')[0] ?? '').trim();

      // An unknown command is a usage error, not a crash.
      err.length = 0;
      try {
        await program.parseAsync(['file', 'definitely-not-a-command'], { from: 'user' });
      } catch {
        // exit is expected to throw
      }
      unknownCommandExitCode = exitCode;
    }
  } catch (error) {
    mountError = error instanceof Error ? error.message : String(error);
  }

  await writeFile(
    observationPath,
    JSON.stringify({
      registeredGroups,
      programError,
      mountAvailable,
      forwardedArgv,
      helpUsageLine,
      unknownCommandExitCode,
      mountError,
    }),
    'utf8'
  );
});
`;

const probeConfigSource = `export default {
  test: {
    environment: 'node',
    include: ['packages/cli/src/cli/.relayflow-1783-surfaces.test.ts'],
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
    'product surface mount probe',
    { RELAY_PR1783_OBSERVATION_PATH: probeObservationPath }
  );

  const observation = JSON.parse(await readFile(probeObservationPath, 'utf8'));
  console.log('Product surface proof observation:', JSON.stringify(observation));

  const groupsPresent = EXPECTED_GROUPS.filter((group) => observation.registeredGroups?.includes(group));

  // Base: none of the groups exist and the mount module is not importable.
  const baseObserved =
    groupsPresent.length === 0 && observation.mountAvailable === false && observation.forwardedArgv === null;

  // Head: every group is registered, argv arrives untouched, help is rendered
  // under the agent-relay name, and an unknown command exits 2.
  const headObserved =
    groupsPresent.length === EXPECTED_GROUPS.length &&
    observation.mountAvailable === true &&
    Array.isArray(observation.forwardedArgv) &&
    observation.forwardedArgv.join(' ') === 'probe-command --flag-the-host-never-heard-of v' &&
    observation.helpUsageLine === 'Usage: agent-relay file [options]' &&
    observation.unknownCommandExitCode === 2;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'absent';
    signature = 'product_groups_absent';
    details =
      'The base CLI registers no file, flows, or sessions group and exposes no product surface mount.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'product_groups_mounted_and_argv_forwarded';
    details =
      'The head CLI registers all three product groups, hands the product its argv verbatim including an unknown flag, renders help as "agent-relay file", and answers an unknown command with exit 2.';
  } else {
    throw new Error(`Unexpected product surface observation: ${JSON.stringify(observation)}.`);
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
