#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { readQualificationParams } from './params.mjs';

const EXPECTED_OPERATION_COUNT = 95;
const EXPECTED_ATTEMPT_COUNT = 190;

try {
  const params = readQualificationParams();
  if (!params) {
    console.error('Usage: final-acceptance.mjs --params <params.json>');
    process.exit(2);
  }
  const verdict = JSON.parse(readFileSync(params.verdictPath, 'utf8'));
  if (
    verdict.verdict !== 'PASS' ||
    verdict.operationCount !== EXPECTED_OPERATION_COUNT ||
    verdict.attemptCount !== EXPECTED_ATTEMPT_COUNT ||
    !Array.isArray(verdict.nodeResourceIds) ||
    verdict.nodeResourceIds.length < 2 ||
    verdict.relayCommitSha !== params.expectedHead
  ) {
    console.error('NOT_PASS: verdict does not satisfy final hard acceptance');
    process.exit(1);
  }
  console.log(
    `FINAL_ACCEPTANCE_OK head=${params.expectedHead} operations=${EXPECTED_OPERATION_COUNT} attempts=${EXPECTED_ATTEMPT_COUNT} nodes=${verdict.nodeResourceIds.length}`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith('NOT_PASS:') ? message : `NOT_PASS: ${message}`);
  process.exit(1);
}
