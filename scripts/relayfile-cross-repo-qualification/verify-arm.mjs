#!/usr/bin/env node
import './config.mjs';

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateArmReport } from './contract.mjs';

const arm = process.argv[2];
if (arm !== 'A' && arm !== 'B') throw new Error('usage: verify-arm.mjs A|B');
const artifactDir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
const reportPath = path.join(artifactDir, `arm-${arm}.json`);
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? '';
let report;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch (error) {
  const result = {
    arm,
    runId,
    status: 'BLOCKED',
    ok: false,
    reason: `arm report is unavailable: ${error.message}`,
  };
  await writeFile(
    path.join(artifactDir, `arm-${arm}-verification.json`),
    `${JSON.stringify(result, null, 2)}\n`
  );
  console.log(`ARM_${arm}_BLOCKED`);
  process.exitCode = 0;
}

if (report) {
  if (report.status === 'BLOCKED') {
    await writeFile(
      path.join(artifactDir, `arm-${arm}-verification.json`),
      `${JSON.stringify(report, null, 2)}\n`
    );
    console.log(`ARM_${arm}_BLOCKED`);
  } else {
    const result = validateArmReport(report);
    if (report.runId !== runId) {
      result.ok = false;
      result.failures.push(
        `arm: report runId ${report.runId ?? '<missing>'} does not match ${runId || '<missing>'}`
      );
    }
    await writeFile(
      path.join(artifactDir, `arm-${arm}-verification.json`),
      `${JSON.stringify({ arm, runId, ...result }, null, 2)}\n`
    );
    if (result.ok) {
      console.log(`ARM_${arm}_OK`);
    } else {
      console.log(`ARM_${arm}_FAIL ${result.failures.join(' | ')}`);
      process.exitCode = 1;
    }
  }
}
