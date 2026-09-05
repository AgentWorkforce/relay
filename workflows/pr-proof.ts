/**
 * PR-specific Cloud red/green proof.
 *
 * The trusted GitHub dispatcher runs this file from the PR base branch and
 * stages `.relayflow/pr-proof-input.json`. PR head code is never executed on
 * the GitHub runner. Each agent step receives a fresh Daytona sandbox from the
 * Cloud SandboxedStepExecutor.
 *
 * Order is deliberate:
 *   1. base-prover observes the exact bug/capability absence on the base SHA;
 *   2. run-scoped Cloud storage hands nonce-bound evidence to a deterministic
 *      gate, which rejects crashes, skips, and wrong signatures;
 *   3. head-verifier observes the declared fixed behavior on the head SHA;
 *   4. a deterministic gate verifies exact SHAs and distinct sandbox IDs.
 */

import { workflow } from '@relayflows/core';

const result = await workflow('relay-pr-proof')
  .description(
    'Prove one declared Relay feature or bug-fix case red on the exact PR base SHA and green on the exact head SHA in distinct Cloud sandboxes.'
  )
  .pattern('dag')
  .channel('relay-pr-proof')
  .maxConcurrency(1)
  // Proof failures are evidence, not repair assignments. This also opts out
  // of RelayFlow's default repair-agent retries so no agent can edit the
  // harness or artifacts after a gate rejects them.
  .onError('fail-fast')
  // Finish inside the dispatcher's 60-minute polling deadline so Cloud can
  // persist terminal step state and retain its sandbox for diagnostics before
  // the GitHub runner issues an external cancellation.
  .timeout(3_300_000)
  .agent('base-prover', {
    cli: 'codex',
    preset: 'worker',
    role: 'Run the trusted PR proof base-arm command exactly once without editing repository files.',
    interactive: false,
    retries: 0,
  })
  .agent('head-verifier', {
    cli: 'codex',
    preset: 'worker',
    role: 'Run the trusted PR proof head-arm command exactly once without editing repository files.',
    interactive: false,
    retries: 0,
  })
  .step('prove-base', {
    agent: 'base-prover',
    task: [
      'This is a deterministic verification assignment. Do not edit any files.',
      'Run exactly: node scripts/pr-proof/run-arm.mjs base .relayflow/pr-proof-input.json',
      'Wait for it to finish. If it succeeds, print its PR_PROOF_ARM_COMPLETE line and then print DONE.',
      'If it fails, preserve the failure and exit non-zero. Do not reinterpret a crash as bug reproduction.',
    ].join('\n'),
    verification: { type: 'output_contains', value: 'PR_PROOF_ARM_COMPLETE arm=base' },
    retries: 0,
  })
  .step('gate-base', {
    type: 'deterministic',
    dependsOn: ['prove-base'],
    command:
      'node scripts/pr-proof/verify-evidence.mjs --source cloud --arm base --input .relayflow/pr-proof-input.json',
    captureOutput: true,
    failOnError: true,
  })
  .step('verify-head', {
    agent: 'head-verifier',
    dependsOn: ['gate-base'],
    task: [
      'This is a deterministic verification assignment. Do not edit any files.',
      'Run exactly: node scripts/pr-proof/run-arm.mjs head .relayflow/pr-proof-input.json',
      'Wait for it to finish. If it succeeds, print its PR_PROOF_ARM_COMPLETE line and then print DONE.',
      'If it fails, preserve the failure and exit non-zero. Do not manufacture or alter evidence.',
    ].join('\n'),
    verification: { type: 'output_contains', value: 'PR_PROOF_ARM_COMPLETE arm=head' },
    retries: 0,
  })
  .step('gate-red-green', {
    type: 'deterministic',
    dependsOn: ['verify-head'],
    command:
      'node scripts/pr-proof/verify-evidence.mjs --source cloud --arm both --input .relayflow/pr-proof-input.json',
    captureOutput: true,
    failOnError: true,
  })
  .run({ cwd: process.cwd() });

if ('status' in result && result.status !== 'completed') {
  process.exitCode = 1;
}
