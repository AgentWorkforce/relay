#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'fleet-spawn-served-action-dispatch';
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
const probePath = path.join(proofDir, 'served-spawn-dispatch.test.mts');
const configPath = path.join(proofDir, 'vitest.config.mts');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
await writeFile(
  configPath,
  `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { environment: 'node', include: ['.relay-pr-proof/served-spawn-dispatch.test.mts'] } });\n`
);

run(process.execPath, [vitestEntry, 'run', '--config', configPath, '--reporter=verbose'], targetDir);

const observation =
  arm === 'base'
    ? {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'bug',
        signature: 'targeted_served_spawn_rewritten_to_generic_spawn',
        details:
          'The base SDK rewrote a targeted spawn:grok placement to the generic spawn action even though sf-frame advertised spawn:grok as a provider-owned action, so the request never reached the Grok provider.',
      }
    : {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'targeted_served_spawn_invokes_advertised_action',
        details:
          'The head SDK invoked the advertised spawn:grok action for the targeted placement and confirmed readiness on that same invocation, while native capacity and automatic placement stayed on the engine spawn dispatcher.',
      };

await writeFile(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
