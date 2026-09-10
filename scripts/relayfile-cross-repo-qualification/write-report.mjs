#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const artifactDir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';

async function readJson(name) {
  try {
    return JSON.parse(await readFile(path.join(artifactDir, name), 'utf8'));
  } catch {
    return undefined;
  }
}

const preflight = await readJson('preflight.json');
const aggregate = await readJson('aggregate.json');
const integrity = await readJson('integrity.json');
const armA = await readJson('arm-A.json');
const armB = await readJson('arm-B.json');
const verdict = aggregate?.verdict === 'PASS' ? 'DONE' : 'BLOCKED';
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? preflight?.runId ?? 'unknown';
const lines = [
  `# Relayfile cross-repo qualification — ${verdict}`,
  '',
  `- Verdict: **${verdict}**`,
  `- Run ID: **${runId}**`,
  `- Daytona creation authorized: **${preflight?.sandboxCreationAuthorized === true ? 'yes' : 'no'}**`,
  `- Arm A evidence: ${armA?.status === 'BLOCKED' ? 'BLOCKED (no sandbox allocated)' : armA ? 'recorded' : 'missing'}`,
  `- Arm B evidence: ${armB?.status === 'BLOCKED' ? 'BLOCKED (no sandbox allocated)' : armB ? 'recorded' : 'missing'}`,
  `- Post-review evidence integrity: **${integrity?.verdict ?? 'missing'}**${integrity?.actualDigest ? ` (${integrity.actualDigest})` : ''}`,
  '- Required fixture: 270,532,608 bytes; 851 files; 454 directories; manifest SHA-256 `905968a14268ec5e8ec38ae1d6b24749e855cac035976a87a65ef43f6612a55a`.',
  '- Required mount shape: one cold mount plus two concurrent consumers, bulk reads only, zero unexpected 429/5xx/resets, actual CPU <= 120,000 ms, suite RSS <= 3 GiB.',
  '- Required ACL shape: all five `workspace_busy` reasons, GET and PUT saturation, write-admission boundary, sustained deadline, and unknown/absent-reason fail-closed proofs.',
  '- Required cleanup: exact owned sandbox ID/name deletion, exhaustive inventory absence, local scratch absence, and immutable bundle context absence.',
  verdict === 'BLOCKED'
    ? '- Remaining risks: no Daytona evidence exists until a fresh run passes preflight, bundle hashing, both arm verifications, Workerd WorkspaceDO ACL case, and deterministic final signoffs.'
    : '- Remaining risks: none recorded by the strict evidence gates.',
  '',
  '## Exact evidence',
  '',
  '```json',
  JSON.stringify({ preflight, aggregate, integrity, arms: { A: armA, B: armB } }, null, 2),
  '```',
  '',
];
await mkdir(artifactDir, { recursive: true });
await writeFile(path.join(artifactDir, 'report.md'), `${lines.join('\n')}\n`);
console.log(`QUALIFICATION_REPORT ${verdict} ${path.join(artifactDir, 'report.md')}`);
