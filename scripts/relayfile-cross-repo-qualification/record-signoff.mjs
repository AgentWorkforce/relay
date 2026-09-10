#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const provider = process.argv[2];
if (!['claude', 'codex'].includes(provider)) throw new Error('usage: record-signoff.mjs claude|codex');
const dir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? '';

async function readArtifact(name) {
  try {
    const bytes = await readFile(path.join(dir, name));
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return undefined;
  }
}

function structurallyValid(value, expectedPhase) {
  return (
    value &&
    value.version === 1 &&
    value.provider === provider &&
    value.phase === expectedPhase &&
    value.runId === runId &&
    (value.verdict === 'COMPREHENSIVELY_SATISFIED' || value.verdict === 'BLOCKED') &&
    Array.isArray(value.findings) &&
    value.findings.every((finding) => typeof finding === 'string' && finding.trim().length > 0) &&
    (value.verdict === 'COMPREHENSIVELY_SATISFIED' ? value.findings.length === 0 : value.findings.length > 0)
  );
}

const preflight = await readArtifact('preflight.json');
const aggregate = await readArtifact('aggregate-evidence.json');
const integrity = await readArtifact('integrity.json');
const armA = await readArtifact('arm-A-verification.json');
const armB = await readArtifact('arm-B-verification.json');
const review = await readArtifact(`${provider}-review.json`);
const fix = await readArtifact(`${provider}-fix.json`);
const finalReview = await readArtifact(`${provider}-final-review.json`);
const failures = [];
if (preflight?.value?.status !== 'READY' || preflight.value.runId !== runId)
  failures.push('preflight is not READY');
for (const [name, artifact] of [
  ['arm A', armA],
  ['arm B', armB],
]) {
  if (artifact?.value?.runId !== runId || artifact.value.ok !== true)
    failures.push(`${name} verification is not green for this run`);
}
if (aggregate?.value?.verdict !== 'PASS' || aggregate.value.runId !== runId)
  failures.push('aggregate evidence is not PASS');
if (integrity?.value?.verdict !== 'PASS' || integrity.value.runId !== runId || integrity.value.ok !== true)
  failures.push('post-review evidence integrity is not PASS');
if (!structurallyValid(review?.value, 'review'))
  failures.push('review artifact is missing, stale, or malformed');
if (!structurallyValid(fix?.value, 'fix')) failures.push('fix artifact is missing, stale, or malformed');
if (!structurallyValid(finalReview?.value, 'final-review'))
  failures.push('final-review artifact is missing, stale, or malformed');

// A review finding cannot disappear across phases. Since this chain has no
// product mutation step, a finding that starts BLOCKED must stay BLOCKED.
if (review?.value?.verdict === 'BLOCKED') {
  if (fix?.value?.verdict !== 'BLOCKED' || finalReview?.value?.verdict !== 'BLOCKED')
    failures.push('an initial blocked finding was forgotten by a later phase');
}
if (fix?.value?.verdict === 'BLOCKED' && finalReview?.value?.verdict !== 'BLOCKED')
  failures.push('a blocked fix finding was forgotten by final-review');
if (fix?.value?.verdict !== 'COMPREHENSIVELY_SATISFIED')
  failures.push('fix phase is not COMPREHENSIVELY_SATISFIED');
if (finalReview?.value?.verdict !== 'COMPREHENSIVELY_SATISFIED')
  failures.push('final-review phase is not COMPREHENSIVELY_SATISFIED');

const hashes = {};
for (const [name, artifact] of [
  [`${provider}-review.json`, review],
  [`${provider}-fix.json`, fix],
  [`${provider}-final-review.json`, finalReview],
])
  hashes[name] = artifact ? createHash('sha256').update(artifact.bytes).digest('hex') : null;

const result = {
  version: 1,
  provider,
  phase: 'final-signoff',
  runId,
  verifiedByScript: true,
  verdict: failures.length === 0 ? 'COMPREHENSIVELY_SATISFIED' : 'BLOCKED',
  evidenceHashes: hashes,
  failures,
};
await writeFile(path.join(dir, `${provider}-signoff.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(`QUALIFICATION_${provider.toUpperCase()}_SIGNOFF ${result.verdict}`);
if (result.verdict !== 'COMPREHENSIVELY_SATISFIED') process.exitCode = 1;
