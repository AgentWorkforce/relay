#!/usr/bin/env node

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
const evidence = await readJson('aggregate-evidence.json');
const integrity = await readJson('integrity.json');
const reportA = await readJson('arm-A.json');
const reportB = await readJson('arm-B.json');
const signoffs = {};
for (const provider of ['claude', 'codex']) {
  const value = await readJson(`${provider}-signoff.json`);
  signoffs[provider] =
    value?.verifiedByScript === true &&
    value?.runId === runId &&
    value?.verdict === 'COMPREHENSIVELY_SATISFIED';
}
let result;
if (preflight?.status !== 'READY' || preflight.runId !== runId) {
  result = { verdict: 'BLOCKED', ok: false, failures: ['preflight is not READY for this run'], signoffs };
} else if (evidence?.verdict !== 'PASS' || evidence.runId !== runId) {
  result = {
    verdict: 'BLOCKED',
    ok: false,
    failures: ['evidence-only aggregate is not PASS for this run'],
    signoffs,
  };
} else if (integrity?.verdict !== 'PASS' || integrity.runId !== runId || integrity.ok !== true) {
  result = {
    verdict: 'BLOCKED',
    ok: false,
    failures: ['post-review evidence integrity is not PASS for this run'],
    signoffs,
  };
} else {
  result = aggregateVerdict({ reportA, reportB, signoffs });
  result.runId = runId;
}
await writeFile(path.join(artifactDir, 'aggregate.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`QUALIFICATION_VERDICT ${result.verdict}`);
for (const failure of result.failures ?? []) console.log(`QUALIFICATION_FAILURE ${failure}`);
