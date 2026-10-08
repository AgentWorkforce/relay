#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1828-fleet-max-agents-display';
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
const probePath = path.join(proofDir, '1828-max-agents.test.mts');
const configPath = path.join(proofDir, '1828-vitest.config.mts');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
await writeFile(
  configPath,
  `import { defineConfig } from 'vitest/config';\nimport targetConfig from '../vitest.config.ts';\n\nexport default defineConfig({ resolve: targetConfig.resolve, test: { environment: 'node', include: ['.relay-pr-proof/1828-max-agents.test.mts'] } });\n`
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
        signature: 'node_up_drops_definition_max_agents',
        details:
          'node up with a discovered agent-relay.mjs declaring maxAgents 15 left AGENT_RELAY_NODE_MAX_AGENTS unset: the broker would register and heartbeat max_agents 0 (unlimited) while the sidecar provider registers 15, so fleet nodes list reports 1/unlimited.',
      }
    : {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'node_up_forwards_definition_max_agents',
        details:
          'node up with a discovered agent-relay.mjs declaring maxAgents 15 sets AGENT_RELAY_NODE_MAX_AGENTS=15 before the broker starts, so the broker registers and heartbeats the configured cap and fleet nodes list reports it.',
      };

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
