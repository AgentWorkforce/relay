#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  candidateManifestSha256,
  canonicalizeCandidateManifest,
  validateQualificationEvidence,
} from './evidence.mjs';
import { FLEET_QUALIFICATION_OPERATIONS } from './matrix.mjs';
import { argument, readQualificationParams } from './params.mjs';

/**
 * Operator-supplied paths arrive through the params file written by the
 * Relayflow, never through a shell command line, so a value containing shell
 * metacharacters cannot be interpreted. The explicit flags remain for direct
 * invocation outside the workflow.
 */
let params;
try {
  params = readQualificationParams();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith('NOT_PASS:') ? message : `NOT_PASS: ${message}`);
  process.exit(1);
}
const input = params?.rawEvidence ?? argument(process.argv, '--input');
const output = params?.verdictPath ?? argument(process.argv, '--output');
const expectedHead = params?.expectedHead ?? argument(process.argv, '--expected-head');
const candidateArtifact = params?.candidateArtifact ?? argument(process.argv, '--candidate-artifact');
const candidateManifest = params?.candidateManifest ?? argument(process.argv, '--candidate-manifest');
if (!input || !output || !expectedHead || !candidateArtifact || !candidateManifest) {
  console.error(
    'Usage: verify-evidence.mjs --params <params.json>\n' +
      '   or: verify-evidence.mjs --input <raw-evidence.json> --output <verdict.json> --expected-head <40-char-sha> --candidate-artifact <packed.tgz> --candidate-manifest <manifest.json>'
  );
  process.exit(2);
}

try {
  const raw = readFileSync(input);
  const evidence = JSON.parse(raw.toString('utf8'));
  const packedArtifactBytes = readFileSync(candidateArtifact);
  const manifestFileBytes = readFileSync(candidateManifest);
  const manifestFileText = manifestFileBytes.toString('utf8');
  const manifestFromFile = JSON.parse(manifestFileText);
  if (manifestFileText !== canonicalizeCandidateManifest(manifestFromFile)) {
    throw new Error(
      'NOT_PASS: candidate manifest file is not normalized RFC 8785/JCS UTF-8 without a newline'
    );
  }
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
