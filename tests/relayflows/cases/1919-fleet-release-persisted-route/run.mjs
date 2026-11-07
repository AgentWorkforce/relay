#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1919-fleet-release-persisted-route';
const arm = requiredValue('RELAY_PR_PROOF_ARM');
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');

if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}
const expectedSha = requiredValue(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
const actualSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (actualSha !== expectedSha) {
  throw new Error(`Target checkout ${actualSha} does not match exact ${arm} SHA ${expectedSha}.`);
}
const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

await rm(resultPath, { force: true });
const proofDir = path.join(targetDir, '.relay-pr-proof');
const probePath = path.join(proofDir, '1919-fleet-release-persisted-route.test.mts');
const observationPath = path.join(proofDir, '1919-fleet-release-persisted-route-observation.json');
const configPath = path.join(proofDir, '1919-vitest.config.mts');
const caseDir = path.dirname(runnerPath);

try {
  const vitestEntry = path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs');
  if (!(await pathExists(vitestEntry))) {
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], targetDir, 'dependency installation');
  }

  await mkdir(proofDir, { recursive: true });
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
  await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
  await writeFile(
    configPath,
    `import { defineConfig } from 'vitest/config';\nimport targetConfig from '../vitest.config.ts';\n\nexport default defineConfig({ resolve: targetConfig.resolve, test: { environment: 'node', include: ['.relay-pr-proof/1919-fleet-release-persisted-route.test.mts'] } });\n`,
    { encoding: 'utf8', flag: 'wx' }
  );
  run(
    process.execPath,
    [vitestEntry, 'run', '--config', configPath, '--reporter=verbose'],
    targetDir,
    'fleet release route probe',
    { RELAY_PR1919_OBSERVATION_PATH: observationPath }
  );

  const observation = JSON.parse(await readFile(observationPath, 'utf8'));
  let outcome;
  let signature;
  let details;
  if (observation.baseObserved === true && observation.headObserved === false) {
    outcome = 'bug';
    signature = 'fleet_release_rejected_persisted_route';
    details =
      'The exact base CLI rejected fleet release because ambient RELAY_BASE_URL conflicted with the persisted isolated route.';
  } else if (observation.baseObserved === false && observation.headObserved === true) {
    outcome = 'fixed';
    signature = 'fleet_release_used_persisted_route';
    details =
      'The exact head CLI released through the persisted isolated origin and its route-scoped credential despite ambient RELAY_BASE_URL.';
  } else {
    throw new Error(`Unexpected fleet release route observation: ${JSON.stringify(observation)}.`);
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
}

/** Read a required non-empty RelayFlow environment value. */
function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

/** Resolve a required RelayFlow directory to an absolute path. */
function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

/** Return true when a candidate path stays inside the expected checkout. */
function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Return true when a filesystem path is accessible. */
async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Run a proof subprocess synchronously and surface a stable labeled failure. */
function run(command, args, cwd, label, extraEnv = {}) {
  const completed = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
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
