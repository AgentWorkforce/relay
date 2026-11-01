#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1922-fleet-release-sandbox-warning';
const arm = required('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') throw new Error('Proof arm must be base or head.');
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
// A failed rerun must not leave a previous successful observation behind.
await rm(resultPath, { force: true });
const expectedSha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
const actualSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (actualSha !== expectedSha) throw new Error(`Target checkout does not match exact ${arm} SHA.`);

const caseDir = path.dirname(fileURLToPath(import.meta.url));
const proofDir = path.join(targetDir, '.relay-pr-proof');
const probePath = path.join(proofDir, `${CASE_ID}.test.mts`);
const configPath = path.join(proofDir, '1922-vitest.config.mts');
const observationPath = path.join(proofDir, '1922-observation.json');

try {
  const vitestEntry = path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs');
  if (!(await exists(vitestEntry))) {
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  }
  await mkdir(proofDir, { recursive: true });
  await rm(observationPath, { force: true });
  await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
  await writeFile(
    configPath,
    `import { defineConfig } from 'vitest/config';\nimport targetConfig from '../vitest.config.ts';\nexport default defineConfig({ resolve: targetConfig.resolve, test: { environment: 'node', include: ['.relay-pr-proof/${CASE_ID}.test.mts'] } });\n`
  );
  run(process.execPath, [vitestEntry, 'run', '--config', configPath, '--reporter=verbose']);
  const observed = JSON.parse(await readFile(observationPath, 'utf8'));
  if (observed.missingWarning === observed.hasWarning) {
    throw new Error('Expected exactly one recognized fleet release observation.');
  }
  const fixed = observed.hasWarning === true;
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome: fixed ? 'fixed' : 'bug',
      signature: fixed
        ? 'fleet_release_warns_sandbox_may_keep_running'
        : 'fleet_release_missing_sandbox_warning',
      details: fixed
        ? 'The dispatched release warns on the default stderr sink that sandbox cost may continue, retaining one unchanged JSON stdout document and making no sandbox deletion request.'
        : 'The dispatched release returns one JSON stdout document but emits no sandbox teardown or continuing-cost warning on the default stderr sink.',
    })}\n`
  );
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
  await rm(observationPath, { force: true });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  const completed = spawnSync(command, args, {
    cwd: targetDir,
    env: { ...process.env, RELAY_PR1922_OBSERVATION_PATH: observationPath },
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 10 * 60 * 1000,
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`Proof subprocess failed (${completed.status}).`);
}
