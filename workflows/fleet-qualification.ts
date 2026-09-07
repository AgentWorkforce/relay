/**
 * Deterministic finalizer for the dual-Daytona Fleet qualification campaign.
 *
 * The live runner supplies its machine-generated raw ledger through
 * FLEET_QUALIFICATION_RAW_EVIDENCE. This Relayflow, at a committed head, owns
 * the source-inventory gate and the only path that can emit a PASS verdict.
 * Narrative or agent transcripts are never inputs to the verdict.
 *
 * Operator-supplied inputs are validated in-process and handed to the
 * deterministic steps through a params file. They are never interpolated into
 * a shell command, so shell metacharacters in an evidence path cannot execute.
 * See scripts/fleet-qualification/preflight.mjs.
 */
import { workflow } from '@relayflows/core';

import {
  BLOCKED_EXIT_CODE,
  buildQualificationCommands,
  QualificationBlockedError,
  resolveQualificationInputs,
  writeQualificationParams,
} from '../scripts/fleet-qualification/preflight.mjs';

async function runWorkflow() {
  const inputs = resolveQualificationInputs(process.env);
  writeQualificationParams(inputs, { cwd: process.cwd() });
  const commands = buildQualificationCommands(inputs);

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
      command: commands.preflight,
      captureOutput: true,
      failOnError: true,
    })
    .step('source-inventory', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: commands.sourceInventory,
      captureOutput: true,
      failOnError: true,
    })
    .step('verify-evidence', {
      type: 'deterministic',
      dependsOn: ['source-inventory'],
      command: commands.verifyEvidence,
      captureOutput: true,
      failOnError: true,
    })
    .step('final-hard-acceptance', {
      type: 'deterministic',
      dependsOn: ['verify-evidence'],
      command: commands.finalAcceptance,
      captureOutput: true,
      failOnError: true,
    })
    .run({ cwd: process.cwd() });

  if ('status' in result && result.status !== 'completed') process.exitCode = 1;
}

runWorkflow().catch((error) => {
  if (error instanceof QualificationBlockedError) {
    console.error(error.message);
    process.exit(BLOCKED_EXIT_CODE);
  }
  console.error(error);
  process.exit(1);
});
