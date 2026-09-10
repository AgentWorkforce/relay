#!/usr/bin/env node
import './config.mjs';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeIntegrity, isSafeDigest } from './integrity.mjs';

const artifactDir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? '';
const expected = process.argv[2] ?? '';
const failures = [];
let actual;
let entries = [];
if (!isSafeDigest(expected)) {
  // Only the workflow runner owns the captured digest. A reviewer or manual
  // invocation without it must fail without creating or replacing the
  // authoritative post-review integrity artifact.
  console.log('QUALIFICATION_INTEGRITY BLOCKED');
  console.log('QUALIFICATION_INTEGRITY_FAILURE runner-captured expected digest is not a safe 64-hex value');
  process.exitCode = 1;
} else {
  try {
    const result = await computeIntegrity(artifactDir);
    actual = result.digest;
    entries = result.entries;
    if (!isSafeDigest(actual)) failures.push('computed digest is not a safe 64-hex value');
    else if (actual !== expected) failures.push('post-review evidence bytes changed');
  } catch (error) {
    failures.push(`integrity recomputation failed: ${String(error?.message ?? error).slice(0, 240)}`);
  }
  const report = {
    version: 1,
    runId,
    expectedDigest: expected,
    actualDigest: isSafeDigest(actual) ? actual : null,
    verdict: failures.length === 0 ? 'PASS' : 'BLOCKED',
    ok: failures.length === 0,
    failures,
    entries,
  };
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'integrity.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`QUALIFICATION_INTEGRITY ${report.verdict}`);
  for (const failure of failures) console.log(`QUALIFICATION_INTEGRITY_FAILURE ${failure}`);
  if (!report.ok) process.exitCode = 1;
}
