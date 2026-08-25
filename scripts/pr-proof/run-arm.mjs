#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ARTIFACT_ROOT,
  INPUT_PATH,
  PR_PROOF_VERSION,
  PrProofContractError,
  validateCaseManifest,
  validateObservation,
  validateProofInput,
} from './contract.mjs';

const MAX_CAPTURE_BYTES = 128 * 1024;

function appendBounded(current, chunk) {
  const next = current + chunk;
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(next.length - MAX_CAPTURE_BYTES);
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = appendBounded(stdout, text);
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = appendBounded(stderr, text);
      process.stderr.write(text);
    });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
        }, options.timeoutMs)
      : null;
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}`
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

function sanitizedCaseEnvironment({ temporaryHome, targetDir, harnessDir, resultPath, input, arm }) {
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
  };
}

function armFromArg() {
  const arm = process.argv[2];
  if (arm !== 'base' && arm !== 'head') throw new Error('Usage: run-arm.mjs <base|head> [input-path]');
  return arm;
}

async function main() {
  const arm = armFromArg();
  const inputPath = process.argv[3] ?? process.env.RELAY_PR_PROOF_INPUT ?? INPUT_PATH;
  const input = validateProofInput(JSON.parse(await readFile(inputPath, 'utf8')));
  const sandboxId = process.env.SANDBOX_ID?.trim();
  if (!sandboxId) throw new Error('SANDBOX_ID is required; this proof arm must run as a Cloud step');

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

    const [command, ...args] = input.manifest.runner.command;
    const result = await run(command, args, {
      cwd: harnessDir,
      env: sanitizedCaseEnvironment({
        temporaryHome,
        targetDir,
        harnessDir,
        resultPath,
        input,
        arm,
      }),
      timeoutMs: input.manifest.timeoutSeconds * 1000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Case runner failed with exit ${result.exitCode}; expected-red behavior must be reported as a successful structured observation`
      );
    }

    let observationJson;
    try {
      observationJson = JSON.parse(await readFile(resultPath, 'utf8'));
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
    console.log(`PR_PROOF_ARM_COMPLETE arm=${arm} case=${input.caseId} sandbox=${sandboxId}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error instanceof PrProofContractError) {
    for (const detail of error.details) console.error(`- ${detail}`);
  }
  process.exitCode = 1;
});
