#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CASE_ID = 'publish-npm-readiness';
const READY_SPEC = '@agent-relay/sdk@11.8.4';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function publishMatrixBlock(workflow) {
  const startMarker = '\n  publish-packages:\n';
  const endMarker = '\n  publish-harnesses:\n';
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error('Could not isolate publish-packages in publish.yml');
  }
  return workflow.slice(start, end);
}

async function helperCanReadPublishedTarball(targetDir) {
  const helper = path.join(targetDir, 'scripts', 'wait-for-npm-package.mjs');
  try {
    await execFileAsync(
      process.execPath,
      [helper, READY_SPEC, '--timeout-seconds', '30', '--interval-seconds', '1'],
      {
        cwd: targetDir,
        timeout: 45_000,
      }
    );
    return true;
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? error.stderr : '';
    console.error(`Readiness helper failed: ${stderr || error}`);
    return false;
  }
}

const arm = requiredEnvironment('RELAY_PR_PROOF_ARM');
const targetDir = requiredEnvironment('RELAY_PR_PROOF_TARGET_DIR');
const resultPath = requiredEnvironment('RELAY_PR_PROOF_RESULT_PATH');
if (arm !== 'base' && arm !== 'head') throw new Error(`Unexpected proof arm: ${arm}`);

const workflow = await readFile(path.join(targetDir, '.github', 'workflows', 'publish.yml'), 'utf8');
const publishMatrix = publishMatrixBlock(workflow);
const publishIndex = publishMatrix.indexOf('npm publish --access public --provenance');
const gateIndex = publishMatrix.indexOf('scripts/wait-for-npm-package.mjs');
const gateFollowsPublish = publishIndex >= 0 && gateIndex > publishIndex;

let outcome;
let signature;
let details;

if (!gateFollowsPublish) {
  outcome = 'bug';
  signature = 'npm_publish_readiness_gate_missing';
  details =
    'The package publish matrix can finish immediately after npm accepts a package for asynchronous processing; no exact-version metadata and tarball readiness gate follows npm publish.';
} else if (await helperCanReadPublishedTarball(targetDir)) {
  outcome = 'fixed';
  signature = 'npm_publish_waits_for_registry_tarball';
  details =
    'The package publish matrix invokes the target checkout readiness helper after npm publish, and that helper confirmed exact-version metadata plus the public SDK tarball.';
} else {
  outcome = 'bug';
  signature = 'npm_publish_readiness_helper_failed';
  details =
    'The workflow references a readiness helper, but the target helper could not confirm exact-version metadata and tarball availability.';
}

await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`
);
console.log(`Observed ${outcome}: ${signature}`);
