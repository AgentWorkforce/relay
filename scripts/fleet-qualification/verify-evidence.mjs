#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { candidateManifestSha256, validateQualificationEvidence } from './evidence.mjs';
import { FLEET_QUALIFICATION_OPERATIONS } from './matrix.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const input = argument('--input');
const output = argument('--output');
const expectedHead = argument('--expected-head');
const candidateArtifact = argument('--candidate-artifact');
const candidateManifest = argument('--candidate-manifest');
if (!input || !output || !expectedHead || !candidateArtifact || !candidateManifest) {
  console.error(
    'Usage: verify-evidence.mjs --input <raw-evidence.json> --output <verdict.json> --expected-head <40-char-sha> --candidate-artifact <packed.tgz> --candidate-manifest <manifest.json>'
  );
  process.exit(2);
}

try {
  const raw = readFileSync(input);
  const evidence = JSON.parse(raw.toString('utf8'));
  const packedArtifactBytes = readFileSync(candidateArtifact);
  const manifestFromFile = JSON.parse(readFileSync(candidateManifest, 'utf8'));
  const verdict = validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS, {
    expectedRelayCommitSha: expectedHead,
    expectedCandidateArtifactSha256: createHash('sha256').update(packedArtifactBytes).digest('hex'),
    expectedCandidateManifestSha256: candidateManifestSha256(manifestFromFile),
  });
  const finalArtifact = {
    schemaVersion: 'relay-fleet-qualification-verdict/1',
    ...verdict,
    sourceEvidenceSha256: createHash('sha256').update(raw).digest('hex'),
    generatedAt: verdict.completedAt,
  };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(finalArtifact, null, 2)}\n`, { flag: 'wx' });
  console.log(
    `FLEET_QUALIFICATION_PASS operations=${verdict.operationCount} attempts=${verdict.attemptCount} nodes=${verdict.nodeResourceIds.join(',')}`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith('NOT_PASS:') ? message : `NOT_PASS: ${message}`);
  process.exit(1);
}
