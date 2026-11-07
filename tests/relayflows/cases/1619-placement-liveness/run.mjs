#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1619-placement-liveness';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const caseDir = path.dirname(fileURLToPath(import.meta.url));

if ((arm !== 'base' && arm !== 'head') || !targetDir || !resultPath) {
  throw new Error('RelayFlow proof environment is incomplete');
}

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
  run('npm', ['ci', '--no-audit', '--no-fund'], targetDir);
}

const proofDir = path.join(targetDir, '.relay-pr-proof');
const probePath = path.join(proofDir, 'placement-liveness.test.mts');
const configPath = path.join(proofDir, 'vitest.config.mts');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
await writeFile(
  configPath,
  `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { environment: 'node', include: ['.relay-pr-proof/placement-liveness.test.mts'] } });\n`
);

run(process.execPath, [vitestEntry, 'run', '--config', configPath, '--reporter=verbose'], targetDir);

const observation =
  arm === 'base'
    ? {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'bug',
        signature: 'placement_accepts_unready_or_policy_ineligible_nodes',
        details:
          'The base SDK selected stale-status and dead-handler nodes, ignored sandbox-only policy, queued an empty roster by default, and retargeted automatic placement.',
      }
    : {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'placement_fails_closed_and_preserves_atomic_selection',
        details:
          'The head SDK rejected stale-status, dead-handler, empty-roster, and sandbox-policy-ineligible placements without invocation, while leaving unconstrained selection atomic.',
      };

await writeFile(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
