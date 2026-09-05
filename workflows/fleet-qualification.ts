/**
 * Deterministic finalizer for the dual-Daytona Fleet qualification campaign.
 *
 * The live runner supplies its machine-generated raw ledger through
 * FLEET_QUALIFICATION_RAW_EVIDENCE. This Relayflow, at a committed head, owns
 * the source-inventory gate and the only path that can emit a PASS verdict.
 * Narrative or agent transcripts are never inputs to the verdict.
 */
import { workflow } from '@relayflows/core';

const runId = process.env.FLEET_QUALIFICATION_RUN_ID ?? `fleet-${Date.now()}`;
const artifacts = `.workflow-artifacts/fleet-qualification/${runId}`;
const rawEvidence = process.env.FLEET_QUALIFICATION_RAW_EVIDENCE ?? '';

async function runWorkflow() {
  const result = await workflow('relay-fleet-qualification')
    .description(
      'Verify the source-derived 95-operation public non-Cloud matrix and emit the final dual-Daytona qualification verdict from deterministic harness evidence.'
    )
    .pattern('dag')
    .channel('relay-fleet-qualification')
    .maxConcurrency(1)
    .timeout(600_000)
    // Evidence failures are terminal NOT_PASS findings. Agents must not repair,
    // reinterpret, or retry an attestation mismatch into a green result.
    .onError('fail-fast')
    .step('preflight', {
      type: 'deterministic',
      command: [
        'set -eu',
        `test -n ${JSON.stringify(rawEvidence)} || { echo "BLOCKED: FLEET_QUALIFICATION_RAW_EVIDENCE is required"; exit 2; }`,
        `test -f ${JSON.stringify(rawEvidence)} || { echo "BLOCKED: raw evidence file is absent"; exit 2; }`,
        `mkdir -p ${JSON.stringify(artifacts)}`,
        'test "$(git status --porcelain --untracked-files=no)" = "" || { echo "BLOCKED: tracked worktree is dirty"; exit 2; }',
        'git rev-parse HEAD',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .step('source-inventory', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command:
        './node_modules/.bin/vitest run tests/fixtures/fleet-qualification-evidence.test.ts -t "source enumeration"',
      captureOutput: true,
      failOnError: true,
    })
    .step('verify-evidence', {
      type: 'deterministic',
      dependsOn: ['source-inventory'],
      command: [
        'set -eu',
        `node scripts/fleet-qualification/verify-evidence.mjs --input ${JSON.stringify(rawEvidence)} --output ${JSON.stringify(`${artifacts}/verdict.json`)}`,
        `test -s ${JSON.stringify(`${artifacts}/verdict.json`)}`,
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .step('final-hard-acceptance', {
      type: 'deterministic',
      dependsOn: ['verify-evidence'],
      command: [
        'set -eu',
        `node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(v.verdict!=="PASS"||v.operationCount!==95||v.attemptCount!==190||v.nodeResourceIds.length<2)process.exit(1);console.log("FINAL_ACCEPTANCE_OK head="+process.argv[2]+" operations=95 attempts=190 nodes="+v.nodeResourceIds.length)' ${JSON.stringify(`${artifacts}/verdict.json`)} "$(git rev-parse HEAD)"`,
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .run({ cwd: process.cwd() });

  if ('status' in result && result.status !== 'completed') process.exitCode = 1;
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
