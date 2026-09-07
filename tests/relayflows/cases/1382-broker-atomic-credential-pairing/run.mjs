#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1382-broker-atomic-credential-pairing';
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
const probePath = path.join(proofDir, 'broker-atomic-credential-pairing.test.mts');
const configPath = path.join(proofDir, 'vitest.config.mts');
await mkdir(proofDir, { recursive: true });
await copyFile(path.join(caseDir, 'probe.test.mts'), probePath);
// Reuse the root config's `resolve.alias` only (not its `test.include`,
// which `mergeConfig` would otherwise concatenate with ours and run the
// whole repo suite): `broker-connection.ts` imports `@agent-relay/config`
// by package name, which only resolves without a prior build via the root
// config's workspace-package -> `src/index.ts` aliases.
await writeFile(
  configPath,
  `import { defineConfig } from 'vitest/config';\nimport rootConfig from '../vitest.config.ts';\n\nexport default defineConfig({\n  resolve: { alias: rootConfig.resolve?.alias },\n  test: { environment: 'node', include: ['.relay-pr-proof/broker-atomic-credential-pairing.test.mts'] },\n});\n`
);

run(process.execPath, [vitestEntry, 'run', '--config', configPath, '--reporter=verbose'], targetDir);

const observation =
  arm === 'base'
    ? {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'bug',
        signature: 'cross_wired_credential_pair_and_probe_abort',
        details:
          'A relay agent\'s own RELAY_BROKER_API_KEY (env) got paired with a different broker\'s URL resolved from connection.json, and the isNativeHarness capability probe\'s rejection propagated instead of degrading, aborting the whole attach.',
      }
    : {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'atomic_credential_pair_and_probe_degrades',
        details:
          'URL and API key now resolve from the same source once the URL comes from env or the connection file (an explicit --api-key still overrides, and an explicit --broker-url still discovers its key normally). isNativeHarness degrades to false on any probe failure instead of aborting the attach.',
      };

await writeFile(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
