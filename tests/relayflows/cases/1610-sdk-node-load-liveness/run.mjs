#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
if (!['base', 'head'].includes(arm) || !targetDir || !resultPath)
  throw new Error('RelayFlow proof environment is incomplete');
const caseDir = path.dirname(fileURLToPath(import.meta.url));
const proofDir = path.join(targetDir, '.relay-pr-proof');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), path.join(proofDir, 'node-load.test.mts'));
await writeFile(
  path.join(proofDir, 'vitest.config.mts'),
  "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { environment: 'node', include: ['.relay-pr-proof/node-load.test.mts'] } });\n"
);
const vitest = path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(
  process.execPath,
  [vitest, 'run', '--config', path.join(proofDir, 'vitest.config.mts')],
  { cwd: targetDir, env: process.env, stdio: 'inherit' }
);
const failed = result.status !== 0;
if ((arm === 'base') !== failed) throw new Error(`unexpected ${arm} result: ${result.status}`);
await writeFile(
  resultPath,
  JSON.stringify(
    {
      version: 1,
      caseId: '1610-sdk-node-load-liveness',
      arm,
      outcome: arm === 'base' ? 'bug' : 'fixed',
      signature: arm === 'base' ? 'offline_node_load_reported_as_measurement' : 'offline_node_load_omitted',
      details: 'SDK translation distinguishes unreachable liveness from measured zero.',
    },
    null,
    2
  ) + '\n'
);
