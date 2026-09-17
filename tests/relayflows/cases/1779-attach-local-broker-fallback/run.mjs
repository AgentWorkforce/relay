#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1779-attach-local-broker-fallback';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const caseDir = path.dirname(fileURLToPath(import.meta.url));

if ((arm !== 'base' && arm !== 'head') || !targetDir || !resultPath) {
  throw new Error('RelayFlow proof environment is incomplete');
}
// A failed rerun must not leave a previous successful observation behind.
await rm(resultPath, { force: true });

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
}

const vitestEntry = path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs');
if (!(await pathExists(vitestEntry))) {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], targetDir);
}

const proofDir = path.join(targetDir, '.relay-pr-proof');
const probePath = path.join(proofDir, '1779-local-broker.test.mts');
const configPath = path.join(proofDir, '1779-vitest.config.mts');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
await writeFile(
  configPath,
  `import { defineConfig } from 'vitest/config';\nimport targetConfig from '../vitest.config.ts';\n\nexport default defineConfig({ resolve: targetConfig.resolve, test: { environment: 'node', include: ['.relay-pr-proof/1779-local-broker.test.mts'] } });\n`
);

try {
  run(process.execPath, [vitestEntry, 'run', '--config', configPath, '--reporter=verbose'], targetDir);
} finally {
  await rm(probePath, { force: true });
  await rm(configPath, { force: true });
}

const observation =
  arm === 'base'
    ? {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'bug',
        signature: 'healthy_local_broker_skipped_for_fleet',
        details:
          'Attach and message flush/hold/auto skipped a healthy discovered broker and reported the persisted Fleet no-placement error. Stale brokers still routed to Fleet.',
      }
    : {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'healthy_local_broker_preferred_stale_broker_falls_through',
        details:
          'Attach and message flush/hold/auto used the healthy discovered local broker. Refused, unhealthy, and hung brokers fell through to Fleet, with the hung probe aborted at 750ms.',
      };

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
