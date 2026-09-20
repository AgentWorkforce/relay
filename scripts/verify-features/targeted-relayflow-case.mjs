#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants, access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  BROKER_RUNTIME_REQUIREMENT,
  caseManifestPath,
  validateCaseManifest,
  validateObservation,
} from '../pr-proof/contract.mjs';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function gitHead(repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git rev-parse failed: ${(result.stderr ?? '').trim()}`);
  return result.stdout.trim();
}

async function main() {
  const caseId = requiredOption('--case');
  const timeoutSeconds = Number(requiredOption('--timeout-seconds'));
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) {
    throw new Error('--timeout-seconds must be an integer from 1 to 1800');
  }
  const repoRoot = process.cwd();
  const manifest = validateCaseManifest(
    JSON.parse(await readFile(path.join(repoRoot, caseManifestPath(caseId)), 'utf8')),
    { caseId }
  );
  const exactTimeoutSeconds = Math.min(timeoutSeconds, manifest.timeoutSeconds);
  const headSha = gitHead(repoRoot);
  const brokerBinary = path.join(repoRoot, 'target/release/agent-relay-broker');
  const needsBroker = manifest.requirements.includes(BROKER_RUNTIME_REQUIREMENT);
  if (needsBroker) {
    try {
      await access(brokerBinary, constants.X_OK);
    } catch {
      throw new Error(`RelayFlow case ${caseId} requires executable ${brokerBinary}`);
    }
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), `relay-targeted-${caseId}-`));
  const resultPath = path.join(temporaryDirectory, 'observation.json');
  try {
    const result = spawnSync(manifest.runner.command[0], manifest.runner.command.slice(1), {
      cwd: repoRoot,
      env: {
        ...process.env,
        RELAY_PR_PROOF_ARM: 'head',
        RELAY_PR_PROOF_CASE_ID: caseId,
        RELAY_PR_PROOF_BASE_SHA: headSha,
        RELAY_PR_PROOF_HEAD_SHA: headSha,
        RELAY_PR_PROOF_TARGET_SHA: headSha,
        RELAY_PR_PROOF_TARGET_DIR: repoRoot,
        RELAY_PR_PROOF_HARNESS_DIR: repoRoot,
        RELAY_PR_PROOF_RESULT_PATH: resultPath,
        RELAY_PR_PROOF_BROKER_BINARY: needsBroker ? brokerBinary : '',
      },
      encoding: 'utf8',
      timeout: exactTimeoutSeconds * 1_000,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`RelayFlow case ${caseId} exited ${result.status ?? result.signal ?? 'unknown'}`);
    }
    const observation = validateObservation(JSON.parse(await readFile(resultPath, 'utf8')), {
      caseId,
      arm: 'head',
      expected: manifest.expected.head,
    });
    console.log(
      `TARGETED_RELAYFLOW_CASE_PASS case=${caseId} signature=${observation.signature} sha=${headSha}`
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
