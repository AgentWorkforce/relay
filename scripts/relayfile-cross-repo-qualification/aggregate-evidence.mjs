#!/usr/bin/env node
import './config.mjs';

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { aggregateVerdict } from './contract.mjs';

const artifactDir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? '';
async function readJson(name) {
  try {
    return JSON.parse(await readFile(path.join(artifactDir, name), 'utf8'));
  } catch {
    return undefined;
  }
}

const preflight = await readJson('preflight.json');
const reportA = await readJson('arm-A.json');
const reportB = await readJson('arm-B.json');
const verificationA = await readJson('arm-A-verification.json');
const verificationB = await readJson('arm-B-verification.json');
let result;
if (preflight?.status !== 'READY' || preflight.runId !== runId) {
  result = { verdict: 'BLOCKED', ok: false, failures: ['preflight is not READY for this run'] };
} else if (
  reportA?.status === 'BLOCKED' ||
  reportB?.status === 'BLOCKED' ||
  verificationA?.ok !== true ||
  verificationB?.ok !== true ||
  verificationA?.runId !== runId ||
  verificationB?.runId !== runId
) {
  result = { verdict: 'BLOCKED', ok: false, failures: ['arm evidence is unavailable or stale'] };
} else {
  result = aggregateVerdict({ reportA, reportB, requireSignoffs: false });
  result.runId = runId;
}
await writeFile(path.join(artifactDir, 'aggregate-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`QUALIFICATION_EVIDENCE_VERDICT ${result.verdict}`);
for (const failure of result.failures ?? []) console.log(`QUALIFICATION_FAILURE ${failure}`);
