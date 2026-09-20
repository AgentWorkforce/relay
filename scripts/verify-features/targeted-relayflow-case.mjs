#!/usr/bin/env node

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
import { runTargetedProcess } from './targeted-process-runner.mjs';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function gitHead(repoRoot) {
  const result = await runTargetedProcess(['git', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    env: process.env,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.timedOut || result.aborted || result.outputLimitExceeded || result.exitCode !== 0) {
    throw new Error(`git rev-parse failed: ${(result.stderr ?? '').trim()}`);
  }
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
  const headSha = await gitHead(repoRoot);
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
    const result = await runTargetedProcess(manifest.runner.command, {
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
      timeoutMs: exactTimeoutSeconds * 1_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.outputLimitExceeded) {
      throw new Error(`RelayFlow case ${caseId} output exceeded ${MAX_OUTPUT_BYTES} bytes`);
    }
    if (result.timedOut) throw new Error(`RelayFlow case ${caseId} timed out after ${exactTimeoutSeconds}s`);
    if (result.aborted) throw new Error(`RelayFlow case ${caseId} aborted`);
    if (result.exitCode !== 0) {
      throw new Error(`RelayFlow case ${caseId} exited ${result.exitCode ?? result.signal ?? 'unknown'}`);
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
