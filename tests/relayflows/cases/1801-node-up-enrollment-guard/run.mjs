#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1801-node-up-enrollment-guard';
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
const probePath = path.join(proofDir, '1801-node-guard.test.mts');
const configPath = path.join(proofDir, '1801-vitest.config.mts');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
await writeFile(
  configPath,
  `import { defineConfig } from 'vitest/config';\nimport targetConfig from '../vitest.config.ts';\n\nexport default defineConfig({ resolve: targetConfig.resolve, test: { environment: 'node', include: ['.relay-pr-proof/1801-node-guard.test.mts'] } });\n`
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
        signature: 'second_node_up_proceeds_past_live_claim',
        details:
          'node up adopted an enrolled node id while a machine-global claim named a live broker pid: runUpCommand was reached, so two brokers would register as the same node and the second would evict the live node\u2019s Cloud delivery socket.',
      }
    : {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'second_node_up_refused_while_claim_held',
        details:
          'node up refused to start before runUpCommand: it reported the holding broker pid and state dir, offered node down / a distinct enrollment / --force, and never reached broker spawn.',
      };

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
