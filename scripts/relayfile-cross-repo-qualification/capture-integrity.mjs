#!/usr/bin/env node

import { computeIntegrity } from './integrity.mjs';

const artifactDir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
try {
  const result = await computeIntegrity(artifactDir);
  // The runner captures this stdout. Reviewers cannot replace the expected
  // digest by rewriting an artifact file.
  process.stdout.write(result.digest);
} catch (error) {
  console.error(`QUALIFICATION_INTEGRITY_CAPTURE_BLOCKED ${String(error?.message ?? error).slice(0, 240)}`);
  process.exitCode = 1;
}
