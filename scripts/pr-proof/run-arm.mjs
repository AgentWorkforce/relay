#!/usr/bin/env node

import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ARTIFACT_ROOT,
  INPUT_PATH,
  PR_PROOF_VERSION,
  PrProofContractError,
  validateCaseManifest,
  validateObservation,
  validateProofInput,
} from './contract.mjs';
import { uploadCloudEvidence, validateCloudEvidenceEnvironment } from './cloud-storage.mjs';
import { runBoundedProcess } from './process-runner.mjs';
import { inspectBrokerArtifact } from './stage-broker-artifacts.mjs';

const MAX_OBSERVATION_FILE_BYTES = 64 * 1024;

async function readObservationFile(filePath) {
  const resultFile = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
  );
  try {
    const resultStat = await resultFile.stat();
    if (!resultStat.isFile()) throw new Error('observation must be a regular, non-symlink file');

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_OBSERVATION_FILE_BYTES) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_OBSERVATION_FILE_BYTES + 1 - totalBytes));
      const { bytesRead } = await resultFile.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_OBSERVATION_FILE_BYTES) {
      throw new Error(`observation must be no larger than ${MAX_OBSERVATION_FILE_BYTES} bytes`);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    await resultFile.close();
  }
}

export async function runProcess(command, args, options = {}) {
  return runBoundedProcess(command, args, options);
}

async function runChecked(command, args, options = {}) {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `${command} ${args.join(' ')} ${result.timedOut ? 'timed out' : `failed with exit ${result.exitCode}`}${result.signal ? ` (${result.signal})` : ''}`
    );
  }
  return result;
}

async function checkout(repository, sha, destination) {
  const remote = `https://github.com/${repository}.git`;
  await mkdir(destination, { recursive: true });
  await runChecked('git', ['init', '--quiet', destination]);
  await runChecked('git', ['-C', destination, 'remote', 'add', 'origin', remote]);
  await runChecked('git', ['-C', destination, 'fetch', '--quiet', '--depth=1', 'origin', sha], {
    timeoutMs: 5 * 60_000,
  });
  await runChecked('git', ['-C', destination, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  const result = await runChecked('git', ['-C', destination, 'rev-parse', 'HEAD']);
  const actual = result.stdout.trim();
  if (actual !== sha) throw new Error(`checkout provenance mismatch: expected ${sha}, got ${actual}`);
  return actual;
}

async function verifiedBrokerPath(input, arm) {
  const artifact = input.runtimeArtifacts?.broker?.[arm];
  if (!artifact) return null;
  const root = process.cwd();
  const artifactPath = path.resolve(root, artifact.path);
  const expectedRoot = path.join(root, '.relayflow', 'pr-proof-binaries') + path.sep;
  if (!artifactPath.startsWith(expectedRoot)) throw new Error('broker artifact escaped its staging root');
  const inspected = await inspectBrokerArtifact({
    arm,
    expectedSha: arm === 'base' ? input.baseSha : input.headSha,
    root,
  });
  if (JSON.stringify(inspected) !== JSON.stringify(artifact)) {
    throw new Error('broker artifact does not match its proof input binding');
  }
  return artifactPath;
}

function sanitizedCaseEnvironment({
  temporaryHome,
  targetDir,
  harnessDir,
  resultPath,
  input,
  arm,
  brokerPath,
}) {
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR'];
  const env = Object.fromEntries(
    allowed.map((key) => [key, process.env[key]]).filter((entry) => typeof entry[1] === 'string' && entry[1])
  );
  return {
    ...env,
    HOME: temporaryHome,
    CI: '1',
    AGENT_RELAY_TELEMETRY_DISABLED: '1',
    RELAY_PR_PROOF_ARM: arm,
    RELAY_PR_PROOF_CASE_ID: input.caseId,
    RELAY_PR_PROOF_BASE_SHA: input.baseSha,
    RELAY_PR_PROOF_HEAD_SHA: input.headSha,
    RELAY_PR_PROOF_TARGET_SHA: arm === 'base' ? input.baseSha : input.headSha,
    RELAY_PR_PROOF_TARGET_DIR: targetDir,
    RELAY_PR_PROOF_HARNESS_DIR: harnessDir,
    RELAY_PR_PROOF_RESULT_PATH: resultPath,
    ...(brokerPath ? { RELAY_PR_PROOF_BROKER_BINARY: brokerPath } : {}),
  };
}

function armFromArg() {
  const arm = process.argv[2];
  if (arm !== 'base' && arm !== 'head') throw new Error('Usage: run-arm.mjs <base|head> [input-path]');
  return arm;
}

export async function main() {
  const arm = armFromArg();
  const inputPath = process.argv[3] ?? process.env.RELAY_PR_PROOF_INPUT ?? INPUT_PATH;
  const input = validateProofInput(JSON.parse(await readFile(inputPath, 'utf8')));
  const sandboxId = process.env.SANDBOX_ID?.trim();
  if (!sandboxId) throw new Error('SANDBOX_ID is required; this proof arm must run as a Cloud step');
  // Validate the Cloud evidence handoff before checking out or executing any
  // PR-authored code, so a misconfigured proof cannot do work it cannot attest.
  validateCloudEvidenceEnvironment(input, arm);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `relay-pr-proof-${arm}-`));
  const harnessDir = path.join(temporaryRoot, 'harness');
  const targetDir = path.join(temporaryRoot, 'target');
  const temporaryHome = path.join(temporaryRoot, 'home');
  const resultPath = path.join(temporaryRoot, 'observation.json');
  const targetSha = arm === 'base' ? input.baseSha : input.headSha;
  const evidencePath = path.join(ARTIFACT_ROOT, `${arm}.json`);

  try {
    await mkdir(temporaryHome, { recursive: true });
    const harnessSha = await checkout(input.repository, input.headSha, harnessDir);
    const actualTargetSha = await checkout(input.repository, targetSha, targetDir);

    const manifestPath = path.join(harnessDir, 'tests', 'relayflows', 'cases', input.caseId, 'case.json');
    const headManifest = validateCaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), {
      caseId: input.caseId,
      kind: input.kind,
    });
    if (JSON.stringify(headManifest) !== JSON.stringify(input.manifest)) {
      throw new Error('Staged case manifest does not match the exact PR head checkout');
    }
    const brokerPath = await verifiedBrokerPath(input, arm);

    const [command, ...args] = input.manifest.runner.command;
    const result = await runProcess(command, args, {
      cwd: harnessDir,
      env: sanitizedCaseEnvironment({
        temporaryHome,
        targetDir,
        harnessDir,
        resultPath,
        input,
        arm,
        brokerPath,
      }),
      timeoutMs: input.manifest.timeoutSeconds * 1000,
    });
    if (result.timedOut) {
      throw new Error(
        `Case runner exceeded ${input.manifest.timeoutSeconds}s; a timeout cannot count as expected-red evidence`
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Case runner failed with exit ${result.exitCode}; expected-red behavior must be reported as a successful structured observation`
      );
    }

    let observationJson;
    try {
      observationJson = JSON.parse(await readObservationFile(resultPath));
    } catch (error) {
      throw new PrProofContractError('Case runner did not write a valid observation JSON file', [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    const observation = validateObservation(observationJson, {
      caseId: input.caseId,
      arm,
      expected: input.manifest.expected[arm],
    });
    const evidence = {
      version: PR_PROOF_VERSION,
      caseId: input.caseId,
      arm,
      repository: input.repository,
      pullRequest: input.pullRequest,
      targetSha: actualTargetSha,
      harnessSha,
      handoffNonce: input.handoffNonce,
      sandboxId,
      runnerExitCode: result.exitCode,
      outcome: observation.outcome,
      signature: observation.signature,
      details: observation.details,
      capturedStdout: result.stdout.slice(-8_000),
      capturedStderr: result.stderr.slice(-8_000),
      completedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await uploadCloudEvidence(input, arm, evidence);
    console.log(`PR_PROOF_ARM_COMPLETE arm=${arm} case=${input.caseId} sandbox=${sandboxId}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    if (error instanceof PrProofContractError) {
      for (const detail of error.details) console.error(`- ${detail}`);
    }
    process.exitCode = 1;
  });
}
