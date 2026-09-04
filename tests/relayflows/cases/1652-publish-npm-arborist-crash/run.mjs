import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1652-publish-npm-arborist-crash';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

// npm 10.9.2 is what CI's Node 22.14.0 base image bundles and what the
// original crash reproduced against (relay#1652). Forcing every arm to
// start from this exact, known-broken baseline — rather than trusting
// whatever npm the Cloud sandbox's ambient Node happens to ship — is what
// makes this a fair test: the only variable between arms is the target
// checkout's own CI recipe, not an accident of sandbox provisioning.
const BROKEN_NPM_VERSION = '10.9.2';
const ARBORIST_CRASH_TEXT = "Cannot read properties of null (reading 'edgesOut')";
// The exact pin line relay#1652 adds to .github/workflows/node-compat.yml's
// fresh-install job. Extracted by regex (not hardcoded to "base has none,
// head has one") so the case keeps proving the real thing if the pinned
// version ever changes, rather than silently degrading into an
// arm-number check.
const PIN_LINE_RE = /run:\s*npm install -g npm@([\w.-]+)/;

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
const targetSha = run('git', ['-C', targetDir, 'rev-parse', 'HEAD'], targetDir, 'git rev-parse').stdout.trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

// Isolated, user-writable npm prefix — never touches the sandbox's system
// npm, so no elevated permissions are needed for the global reinstalls
// below.
const npmPrefix = await mkdtemp(path.join(tmpdir(), 'relayflow-1652-npm-'));
const npmBin = path.join(npmPrefix, 'bin');
const npmEnv = {
  ...process.env,
  PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ''}`,
  npm_config_prefix: npmPrefix,
  NPM_CONFIG_PREFIX: npmPrefix,
};

let details;
let outcome;
let signature;

try {
  // Establish the known-broken baseline. Each spawnSync call below is its
  // own process with a fresh PATH lookup, so — unlike a persistent bash
  // session — there's no command-hash-caching hazard here (see the
  // verify-install.sh fix in this same PR for why that matters).
  run(
    'npm',
    ['install', '-g', `npm@${BROKEN_NPM_VERSION}`],
    targetDir,
    `install baseline npm@${BROKEN_NPM_VERSION}`,
    npmEnv
  );
  const baselineVersion = run('npm', ['--version'], targetDir, 'npm --version (baseline)', npmEnv).stdout.trim();
  if (baselineVersion !== BROKEN_NPM_VERSION) {
    throw new Error(`Baseline npm install did not take effect: expected ${BROKEN_NPM_VERSION}, got ${baselineVersion}.`);
  }

  // Apply whatever fix the target checkout actually defines, if any —
  // driven by the checkout's own content, not by which arm this is.
  const workflowPath = path.join(targetDir, '.github/workflows/node-compat.yml');
  const workflowSource = await readFile(workflowPath, 'utf8');
  const pinMatch = workflowSource.match(PIN_LINE_RE);
  let pinnedVersion = null;
  if (pinMatch) {
    pinnedVersion = pinMatch[1];
    run('npm', ['install', '-g', `npm@${pinnedVersion}`], targetDir, `apply target's npm@${pinnedVersion} pin`, npmEnv);
  }

  // The exact "fresh install" recipe from node-compat.yml's fresh-install
  // job / publish.yml's version-bump reinstall: no lockfile, no cache.
  await rm(path.join(targetDir, 'node_modules'), { recursive: true, force: true });
  await rm(path.join(targetDir, 'package-lock.json'), { force: true });
  const packagesDir = path.join(targetDir, 'packages');
  for (const entry of await readdirSafe(packagesDir)) {
    await rm(path.join(packagesDir, entry, 'node_modules'), { recursive: true, force: true });
  }

  const install = spawnSync('npm', ['install'], {
    cwd: targetDir,
    env: npmEnv,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (install.error) {
    throw new Error(`npm install could not start: ${install.error.message}`);
  }
  const combinedOutput = `${install.stdout ?? ''}${install.stderr ?? ''}`;
  const isArboristCrash = combinedOutput.includes(ARBORIST_CRASH_TEXT);

  if (install.status === 0) {
    outcome = 'fixed';
    signature = 'npm_pin_prevents_arborist_crash';
    details = pinnedVersion
      ? `npm install succeeded after applying the checkout's own npm@${pinnedVersion} pin (started from the known-broken npm@${BROKEN_NPM_VERSION} baseline).`
      : `npm install succeeded from the npm@${BROKEN_NPM_VERSION} baseline with no pin present in node-compat.yml.`;
  } else if (isArboristCrash) {
    outcome = 'bug';
    signature = 'npm_arborist_edges_out_crash';
    details = pinnedVersion
      ? `npm install crashed with the known arborist edgesOut null-deref (npm/cli#8261) even though a npm@${pinnedVersion} pin was present and applied — unexpected.`
      : `npm install crashed with the known arborist edgesOut null-deref (npm/cli#8261) under npm@${BROKEN_NPM_VERSION}; no pin step found in node-compat.yml's fresh-install job.`;
  } else {
    throw new Error(
      `npm install failed for a reason other than the arborist crash (exit ${install.status ?? 'unknown'}, signal ${install.signal ?? 'none'}): ${combinedOutput.slice(-2000)}`
    );
  }
} finally {
  await rm(npmPrefix, { recursive: true, force: true });
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`
);

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

async function readdirSafe(directory) {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function run(command, args, cwd, label, extraEnv) {
  const completed = spawnSync(command, args, {
    cwd,
    env: extraEnv ?? process.env,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${
        completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status ?? 'unknown'}`
      }: ${(completed.stderr ?? '').slice(-2000)}`
    );
  }
  return completed;
}
