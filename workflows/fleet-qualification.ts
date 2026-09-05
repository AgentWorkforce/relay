/**
 * Deterministic finalizer for the dual-Daytona Fleet qualification campaign.
 *
 * The live runner supplies its machine-generated raw ledger through
 * FLEET_QUALIFICATION_RAW_EVIDENCE. This Relayflow, at a committed head, owns
 * the source-inventory gate and the only path that can emit a PASS verdict.
 * Narrative or agent transcripts are never inputs to the verdict.
 */
import { workflow } from '@relayflows/core';

const requestedRunId = process.env.FLEET_QUALIFICATION_RUN_ID ?? `fleet-${Date.now()}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestedRunId)) {
  throw new Error('FLEET_QUALIFICATION_RUN_ID must be a safe 1-128 character artifact name');
}
const runId = requestedRunId;
const artifacts = `.workflow-artifacts/fleet-qualification/${runId}`;
const rawEvidence = process.env.FLEET_QUALIFICATION_RAW_EVIDENCE ?? '';
const expectedHead = process.env.FLEET_QUALIFICATION_EXPECTED_HEAD ?? '';
const candidateArtifact = process.env.FLEET_QUALIFICATION_CANDIDATE_ARTIFACT ?? '';
const candidateManifest = process.env.FLEET_QUALIFICATION_CANDIDATE_MANIFEST ?? '';

const shQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

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
        `test -n ${shQuote(rawEvidence)} || { echo "BLOCKED: FLEET_QUALIFICATION_RAW_EVIDENCE is required"; exit 2; }`,
        `test -f ${shQuote(rawEvidence)} || { echo "BLOCKED: raw evidence file is absent"; exit 2; }`,
        `test -f ${shQuote(candidateArtifact)} || { echo "BLOCKED: packed candidate artifact is absent"; exit 2; }`,
        `test -f ${shQuote(candidateManifest)} || { echo "BLOCKED: candidate manifest is absent"; exit 2; }`,
        `printf '%s' ${shQuote(expectedHead)} | grep -Eq '^[0-9a-fA-F]{40}$' || { echo "BLOCKED: FLEET_QUALIFICATION_EXPECTED_HEAD must be a full Git SHA"; exit 2; }`,
        `mkdir -p ${shQuote(artifacts)}`,
        'test "$(git status --porcelain --untracked-files=no)" = "" || { echo "BLOCKED: tracked worktree is dirty"; exit 2; }',
        `test "$(git rev-parse HEAD)" = ${shQuote(expectedHead.toLowerCase())} || { echo "BLOCKED: worktree HEAD differs from FLEET_QUALIFICATION_EXPECTED_HEAD"; exit 2; }`,
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
        `node scripts/fleet-qualification/verify-evidence.mjs --input ${shQuote(rawEvidence)} --output ${shQuote(`${artifacts}/verdict.json`)} --expected-head ${shQuote(expectedHead.toLowerCase())} --candidate-artifact ${shQuote(candidateArtifact)} --candidate-manifest ${shQuote(candidateManifest)}`,
        `test -s ${shQuote(`${artifacts}/verdict.json`)}`,
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .step('final-hard-acceptance', {
      type: 'deterministic',
      dependsOn: ['verify-evidence'],
      command: [
        'set -eu',
        `node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(v.verdict!=="PASS"||v.operationCount!==95||v.attemptCount!==190||v.nodeResourceIds.length<2||v.relayCommitSha!==process.argv[2])process.exit(1);console.log("FINAL_ACCEPTANCE_OK head="+process.argv[2]+" operations=95 attempts=190 nodes="+v.nodeResourceIds.length)' ${shQuote(`${artifacts}/verdict.json`)} ${shQuote(expectedHead.toLowerCase())}`,
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
