// RelayFlow proof for #1649: a lockfile-less `npm install` on npm 10.9 must
// survive `@vitejs/devtools-vitest`'s wildcard `vitest` peer.
//
// Since vitest 5.0.0 was published (2026-09-03 12:24 UTC), that wildcard
// resolves to vitest 5 even though every workspace range is ^4, and npm 10.9's
// arborist crashes building the peer set. The head arm carries a root
// `overrides` entry that pins that one peer edge to the workspace range.
//
// The probe copies ONLY the workspace manifests (root + packages/*) out of the
// exact target checkout into a scratch directory, without the lockfile, and
// asks a pinned npm 10.9.2 to build an ideal tree (`--package-lock-only`, no
// scripts). The runner's own npm version is irrelevant: `npx npm@10.9.2` is
// the resolver under test on both arms.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1649-fresh-install-vitest-peer';
const NPM_UNDER_TEST = 'npm@10.9.2';
const CRASH_MARKER = "Cannot read properties of null (reading 'edgesOut')";
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

const probeDir = await mkdtemp(path.join(os.tmpdir(), `relayflow-${CASE_ID}-`));
try {
  const copied = await copyWorkspaceManifests(targetDir, probeDir);
  console.log(`Copied ${copied} workspace manifests from ${targetSha} into ${probeDir}`);

  const rootManifest = JSON.parse(await readFile(path.join(probeDir, 'package.json'), 'utf8'));
  const rootRange = rootManifest.devDependencies?.vitest ?? rootManifest.dependencies?.vitest;
  if (typeof rootRange !== 'string' || !rootRange.startsWith('^4')) {
    throw new Error(
      `This proof assumes the workspace pins vitest ^4; the root manifest asks for ${JSON.stringify(rootRange)}.`
    );
  }

  const install = spawnSync(
    'npx',
    [
      '--yes',
      '--package',
      NPM_UNDER_TEST,
      '--',
      'npm',
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel',
      'error',
    ],
    {
      cwd: probeDir,
      env: { ...process.env, npm_config_update_notifier: 'false' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: COMMAND_TIMEOUT_MS,
    }
  );
  if (install.error) {
    // spawnSync reports its own timeout as an error with code ETIMEDOUT; a
    // slow registry is an infrastructure failure, not a launch failure.
    const cause =
      install.error.code === 'ETIMEDOUT'
        ? `timed out after ${COMMAND_TIMEOUT_MS}ms`
        : `could not start: ${install.error.message}`;
    throw new Error(`${NPM_UNDER_TEST} ${cause}`);
  }
  const stderr = install.stderr ?? '';
  const stdout = install.stdout ?? '';
  console.log(`${NPM_UNDER_TEST} install exited with ${install.status ?? `signal ${install.signal}`}`);
  if (stderr.trim()) console.log(stderr.trim().split('\n').slice(-8).join('\n'));

  let outcome;
  let signature;
  let details;
  if (install.status !== 0 && stderr.includes(CRASH_MARKER)) {
    outcome = 'bug';
    signature = 'fresh_install_crashes_on_wildcard_vitest_peer';
    details = `${NPM_UNDER_TEST} could not build an ideal tree from the ${arm} manifests: arborist crashed with "${CRASH_MARKER}" while loading the peer set that @vitejs/devtools-vitest's wildcard vitest peer pulls in.`;
  } else if (install.status === 0) {
    const lock = JSON.parse(await readFile(path.join(probeDir, 'package-lock.json'), 'utf8'));
    const resolved = lock.packages?.['node_modules/vitest']?.version;
    if (typeof resolved !== 'string' || !resolved.startsWith('4.')) {
      throw new Error(
        `Install succeeded but resolved vitest ${JSON.stringify(resolved)}; expected a 4.x matching ${rootRange}.`
      );
    }
    outcome = 'fixed';
    signature = 'fresh_install_resolves_vitest_4';
    details = `${NPM_UNDER_TEST} built an ideal tree from the ${arm} manifests without a lockfile and resolved vitest ${resolved} for the workspace range ${rootRange}.`;
  } else {
    throw new Error(
      `Unexpected ${NPM_UNDER_TEST} outcome (exit ${install.status ?? install.signal}): ${(stderr || stdout)
        .trim()
        .split('\n')
        .slice(-5)
        .join(' | ')}`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  await rm(probeDir, { recursive: true, force: true });
}

async function copyWorkspaceManifests(sourceRoot, destinationRoot) {
  await copyFile(path.join(sourceRoot, 'package.json'), path.join(destinationRoot, 'package.json'));
  let count = 1;
  const packagesDir = path.join(sourceRoot, 'packages');
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(packagesDir, entry.name, 'package.json');
    let source;
    try {
      source = await readFile(manifest);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const destination = path.join(destinationRoot, 'packages', entry.name);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'package.json'), source);
    count += 1;
  }
  return count;
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
