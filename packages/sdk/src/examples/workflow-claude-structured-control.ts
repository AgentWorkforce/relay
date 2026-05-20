/**
 * Claude-Inspired Structured Control Campaign
 *
 * Goal:
 *   Add typed control messages, plan checkpoints, and phase-aware channel
 *   management so Relay can coordinate better than Claude Code while keeping
 *   explicit workflow structure and broker observability.
 */

import { workflow } from '../workflows/builder.js';
import type { WorkflowEvent } from '../workflows/runner.js';

const PROTOCOL = 'packages/sdk/src/protocol.ts';
const CLIENT = 'packages/sdk/src/client.ts';
const RELAY = 'packages/sdk/src/relay.ts';
const RUNNER = 'packages/sdk/src/workflows/runner.ts';
const COORDINATOR = 'packages/sdk/src/workflows/coordinator.ts';
const CHANNEL_TEST = 'packages/sdk/src/__tests__/channel-management.test.ts';
const RELAY_CHANNEL_TEST = 'packages/sdk/src/__tests__/relay-channel-ops.test.ts';
const COMM_CORE_TEST = 'packages/sdk/src/__tests__/communicate/core.test.ts';
const PLAN_FILE = '.agent-relay/plans/claude-structured-control.md';

function onEvent(event: WorkflowEvent): void {
  const ts = new Date().toISOString();
  if (event.type === 'step:started') console.log(`[${ts}] -> ${event.stepName}`);
  if (event.type === 'step:completed') console.log(`[${ts}] ok ${event.stepName}`);
  if (event.type === 'step:failed') console.error(`[${ts}] !! ${event.stepName}: ${event.error}`);
  if (event.type === 'run:failed') console.error(`[${ts}] run failed ${event.runId}: ${event.error}`);
}

const result = await workflow('claude-structured-control-campaign')
  .description(
    'Implement typed control messages, explicit plan checkpoints, and phase-aware channel isolation ' +
      'so Relay coordination is more powerful and observable than Claude Code task notifications.'
  )
  .pattern('dag')
  .channel('wf-claude-structured-control')
  .maxConcurrency(3)
  .timeout(10_800_000)
  .idleNudge({ nudgeAfterMs: 180_000, escalateAfterMs: 180_000, maxNudges: 2 })
  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })

  .agent('lead', {
    cli: 'claude',
    preset: 'lead',
    role:
      'Lead architect. Must use Relay strengths: explicit topology, typed workflow state, and broker-visible control flow.',
    retries: 2,
  })
  .agent('control-analyst', {
    cli: 'claude',
    role:
      'Control-plane analyst. Produces the implementation plan for typed control messages and phase-aware channels.',
    retries: 2,
  })
  .agent('protocol-engineer', {
    cli: 'codex',
    role:
      'Protocol engineer. Adds typed control envelopes for plan approval, shutdown, handoff, and structured completion.',
    retries: 2,
  })
  .agent('runner-engineer', {
    cli: 'codex',
    role:
      'Runner engineer. Adds plan checkpoints, explicit control handling, and richer completion state.',
    retries: 2,
  })
  .agent('channel-engineer', {
    cli: 'codex',
    role:
      'Channel engineer. Applies phase-aware subscribe/unsubscribe/mute/unmute behavior so teams stay quiet by default.',
    retries: 2,
  })
  .agent('qa-engineer', {
    cli: 'codex',
    role:
      'QA engineer. Adds focused tests for structured control and phase-aware channels.',
    retries: 2,
  })

  .step('analyze-structured-control', {
    agent: 'control-analyst',
    task: `
Study the current control and channel surfaces across:
  - ${PROTOCOL}
  - ${CLIENT}
  - ${RELAY}
  - ${RUNNER}
  - ${COORDINATOR}

Write a concrete plan to ${PLAN_FILE}. The plan must define:
  1. typed control messages for plan approval, shutdown, handoff, and task completion
  2. runner plan checkpoints / approval gates
  3. phase-aware channel subscribe/unsubscribe/mute/unmute behavior
  4. tests to update for both control and channel flow

Write the plan to disk. Do not only print it.
`,
    verification: { type: 'file_exists', value: PLAN_FILE },
    retries: 2,
  })
  .step('read-structured-control-plan', {
    type: 'deterministic',
    dependsOn: ['analyze-structured-control'],
    command: `cat ${PLAN_FILE}`,
    captureOutput: true,
    failOnError: true,
  })
  .step('protocol-control-envelope', {
    agent: 'protocol-engineer',
    dependsOn: ['read-structured-control-plan'],
    task: `
Implement typed control envelopes from the approved plan:
{{steps.read-structured-control-plan.output}}

Edit only:
  - ${PROTOCOL}
  - ${CLIENT}
  - ${RELAY}

Required outcomes:
  - define typed plan/shutdown/handoff/completion control messages
  - keep compatibility with existing text-message paths
  - make the SDK consume and expose these control messages cleanly
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-protocol-control-envelope', {
    type: 'deterministic',
    dependsOn: ['protocol-control-envelope'],
    command: `
if git diff --quiet -- ${PROTOCOL} ${CLIENT} ${RELAY}; then
  echo "UNCHANGED: control envelope"
  exit 1
fi
echo "UPDATED: control envelope"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('runner-plan-checkpoints', {
    agent: 'runner-engineer',
    dependsOn: ['read-structured-control-plan', 'verify-protocol-control-envelope'],
    task: `
Implement runner-side structured control handling from:
{{steps.read-structured-control-plan.output}}

Edit only:
  - ${RUNNER}
  - ${COORDINATOR}

Required outcomes:
  - add explicit plan checkpoints or approval hooks
  - make runner/coordinator consume typed control messages rather than ad hoc text signals
  - keep Relay explicit and observable through events
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-runner-plan-checkpoints', {
    type: 'deterministic',
    dependsOn: ['runner-plan-checkpoints'],
    command: `
if git diff --quiet -- ${RUNNER} ${COORDINATOR}; then
  echo "UNCHANGED: runner/coordinator"
  exit 1
fi
echo "UPDATED: runner/coordinator"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('phase-aware-channel-control', {
    agent: 'channel-engineer',
    dependsOn: ['read-structured-control-plan', 'verify-runner-plan-checkpoints'],
    task: `
Implement the phase-aware channel behavior described in:
{{steps.read-structured-control-plan.output}}

Edit only:
  - ${RUNNER}
  - ${RELAY}
  - ${CLIENT}

Required outcomes:
  - make phase transitions able to subscribe/unsubscribe/mute/unmute workers intentionally
  - reduce main-channel noise for long-running workflows
  - preserve current channel APIs and broker visibility
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-phase-aware-channel-control', {
    type: 'deterministic',
    dependsOn: ['phase-aware-channel-control'],
    command: `
if git diff --quiet -- ${RUNNER} ${RELAY} ${CLIENT}; then
  echo "UNCHANGED: phase-aware channels"
  exit 1
fi
echo "UPDATED: phase-aware channels"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('structured-control-tests', {
    agent: 'qa-engineer',
    dependsOn: ['verify-protocol-control-envelope', 'verify-runner-plan-checkpoints', 'verify-phase-aware-channel-control'],
    task: `
Add focused tests for the new structured control and phase-aware channel behavior.

Primary files:
  - ${CHANNEL_TEST}
  - ${RELAY_CHANNEL_TEST}
  - ${COMM_CORE_TEST}

Cover:
  - typed plan approval / shutdown / handoff messages
  - runner/coordinator handling of structured control
  - phase-aware subscribe/unsubscribe/mute/unmute flows
  - backwards compatibility for older plain-text control paths
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-structured-control-tests', {
    type: 'deterministic',
    dependsOn: ['structured-control-tests'],
    command: `
if git diff --quiet -- packages/sdk/src/__tests__; then
  echo "UNCHANGED: structured control tests"
  exit 1
fi
echo "UPDATED: structured control tests"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('lead-review-structured-control', {
    agent: 'lead',
    dependsOn: [
      'verify-protocol-control-envelope',
      'verify-runner-plan-checkpoints',
      'verify-phase-aware-channel-control',
      'verify-structured-control-tests',
    ],
    task: `
Review the structured control implementation against ${PLAN_FILE}.

Review files:
  - ${PROTOCOL}
  - ${CLIENT}
  - ${RELAY}
  - ${RUNNER}
  - ${COORDINATOR}
  - ${CHANNEL_TEST}
  - ${RELAY_CHANNEL_TEST}
  - ${COMM_CORE_TEST}

Accept only if:
  - Relay now has typed control better than Claude Code's task-notification convention
  - channel isolation is phase-aware and practical for noisy multi-agent runs
  - the system remains explicit, observable, and testable
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('structured-control-check', {
    type: 'deterministic',
    dependsOn: ['lead-review-structured-control'],
    command:
      'npx vitest run ' +
      'packages/sdk/src/__tests__/channel-management.test.ts ' +
      'packages/sdk/src/__tests__/relay-channel-ops.test.ts ' +
      'packages/sdk/src/__tests__/communicate/core.test.ts',
    captureOutput: true,
    failOnError: true,
    timeoutMs: 1_200_000,
  })
  .run({
    cwd: process.cwd(),
    onEvent,
  });

console.log(
  JSON.stringify({ workflow: 'claude-structured-control-campaign', status: result.status }, null, 2)
);
