#!/usr/bin/env node
import './config.mjs';

/** Final workflow gate: a completed workflow is acceptable only with PASS evidence and both signoffs. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const artifactDir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? '';
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

async function readJson(name) {
  try {
    return JSON.parse(await readFile(path.join(artifactDir, name), 'utf8'));
  } catch {
    return undefined;
  }
}

const aggregate = await readJson('aggregate.json');
const integrity = await readJson('integrity.json');
const failures = [];
if (!RUN_ID_PATTERN.test(runId)) failures.push('run ID is missing or unsafe');
if (aggregate?.runId !== runId || aggregate?.verdict !== 'PASS') {
  failures.push('current run-scoped aggregate.json is not PASS');
}
if (integrity?.runId !== runId || integrity?.verdict !== 'PASS' || integrity?.ok !== true) {
  failures.push('post-review evidence integrity is not PASS');
}
for (const provider of ['claude', 'codex']) {
  const signoff = await readJson(`${provider}-signoff.json`);
  if (
    signoff?.runId !== runId ||
    signoff?.verifiedByScript !== true ||
    signoff?.verdict !== 'COMPREHENSIVELY_SATISFIED'
  ) {
    failures.push(`${provider} signoff is not verified for this run`);
  }
}

const result = {
  version: 1,
  runId,
  verdict: failures.length === 0 ? 'PASS' : 'BLOCKED',
  ok: failures.length === 0,
  failures,
};
await mkdir(artifactDir, { recursive: true });
await writeFile(path.join(artifactDir, 'final-acceptance.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`QUALIFICATION_FINAL_ACCEPTANCE ${result.verdict}`);
for (const failure of failures) console.log(`QUALIFICATION_FINAL_ACCEPTANCE_FAILURE ${failure}`);
if (!result.ok) process.exitCode = 1;
