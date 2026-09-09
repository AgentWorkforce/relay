/**
 * Claude-Inspired Task Runtime Campaign
 *
 * Goal:
 *   Upgrade Agent Relay from process-centric worker tracking to a first-class
 *   task runtime with durable task handles, pending messages, result payloads,
 *   and manager-owned completion semantics.
 *
 * This workflow keeps Relay's explicit DAG model, but implements the most
 * useful Claude Code ideas:
 *   - task objects instead of raw worker bookkeeping
 *   - resumable continuation handles
 *   - structured result envelopes
 *   - fewer prompt-level "/exit" / "agent_remove" requirements
 */

import { workflow } from '../workflows/builder.js';
import type { WorkflowEvent } from '../workflows/runner.js';

const PROTOCOL = 'packages/sdk/src/protocol.ts';
const CLIENT = 'packages/sdk/src/client.ts';
const RELAY = 'packages/sdk/src/relay.ts';
const RUNNER = 'packages/sdk/src/workflows/runner.ts';
const MAIN_RS = 'src/main.rs';
const SUPERVISOR_RS = 'src/supervisor.rs';
const FACADE_TEST = 'packages/sdk/src/__tests__/facade.test.ts';
const RUNNER_TEST = 'packages/sdk/src/__tests__/workflow-runner.test.ts';
const PLAN_FILE = '.agent-relay/plans/claude-task-runtime.md';

function onEvent(event: WorkflowEvent): void {
  const ts = new Date().toISOString();
  switch (event.type) {
    case 'run:started':
      console.log(`[${ts}] run started ${event.runId}`);
      break;
    case 'run:completed':
      console.log(`[${ts}] run completed ${event.runId}`);
      break;
    case 'run:failed':
      console.error(`[${ts}] run failed ${event.runId}: ${event.error}`);
      break;
    case 'step:started':
      console.log(`[${ts}] -> ${event.stepName}`);
      break;
    case 'step:completed':
      console.log(`[${ts}] ok ${event.stepName}`);
      break;
    case 'step:failed':
      console.error(`[${ts}] !! ${event.stepName}: ${event.error}`);
      break;
  }
}

const result = await workflow('claude-task-runtime-campaign')
  .description(
    'Implement a first-class Relay task runtime inspired by Claude Code task objects, ' +
      'while preserving Relay DAGs, verification, and broker-managed orchestration.'
  )
  .pattern('dag')
  .channel('wf-claude-task-runtime')
  .maxConcurrency(3)
  .timeout(10_800_000)
  .idleNudge({ nudgeAfterMs: 180_000, escalateAfterMs: 180_000, maxNudges: 2 })
  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })

  .agent('lead', {
    cli: 'claude',
    preset: 'lead',
    role:
      'Lead architect. Keeps the DAG small, reviews boundaries, and protects Relay explicitness. ' +
      'Must reject any design that turns workflows into opaque prompt orchestration.',
    retries: 2,
  })
  .agent('runtime-analyst', {
    cli: 'claude',
    role:
      'Runtime analyst. Reads the current SDK and broker lifecycle, then writes a precise implementation plan ' +
      'for task handles, message queues, result envelopes, and completion ownership.',
    retries: 2,
  })
  .agent('protocol-engineer', {
    cli: 'codex',
    role:
      'SDK protocol engineer. Extends protocol and client contracts for task handles, task status, and structured completion.',
    retries: 2,
  })
  .agent('sdk-engineer', {
    cli: 'codex',
    role:
      'SDK facade engineer. Adds public task-centric APIs on top of AgentRelay and keeps backwards compatibility.',
    retries: 2,
  })
  .agent('runner-engineer', {
    cli: 'codex',
    role:
      'Workflow runner engineer. Migrates the runner from workers.json-first thinking toward task records, pending messages, and result envelopes.',
    retries: 2,
  })
  .agent('broker-engineer', {
    cli: 'codex',
    role:
      'Broker engineer. Updates the Rust broker and supervisor so completion is broker-owned and observable instead of prompt-owned.',
    retries: 2,
  })
  .agent('qa-engineer', {
    cli: 'codex',
    role:
      'QA engineer. Adds focused tests for task handles, completion reasons, pending messages, and runner integration.',
    retries: 2,
  })

  .step('analyze-current-runtime', {
    agent: 'runtime-analyst',
    task: `
Study the current Relay task and worker lifecycle across:
  - ${PROTOCOL}
  - ${CLIENT}
  - ${RELAY}
  - ${RUNNER}
  - ${MAIN_RS}
  - ${SUPERVISOR_RS}

Write a concrete plan to ${PLAN_FILE}. The plan must cover:
  1. A task handle / task record abstraction with stable IDs
  2. Pending inbound messages queued per task
  3. Structured completion payloads and completion reasons
  4. Manager-owned completion instead of prompt-owned "/exit" behavior
  5. Backwards-compatible facade APIs
  6. Targeted test files to update

Keep the plan implementation-oriented. Write the file to disk. Do not only print it.
`,
    verification: { type: 'file_exists', value: PLAN_FILE },
    retries: 2,
  })
  .step('read-runtime-plan', {
    type: 'deterministic',
    dependsOn: ['analyze-current-runtime'],
    command: `cat ${PLAN_FILE}`,
    captureOutput: true,
    failOnError: true,
  })
  .step('protocol-task-envelope', {
    agent: 'protocol-engineer',
    dependsOn: ['read-runtime-plan'],
    task: `
Implement the protocol-side portion of the task runtime plan from:
{{steps.read-runtime-plan.output}}

Edit only these files:
  - ${PROTOCOL}
  - ${CLIENT}

Required outcomes:
  - introduce stable task/task-handle concepts where the SDK can observe them
  - define structured task status / completion data instead of relying only on raw worker exits
  - keep current spawn/message/release paths backwards-compatible
  - add comments only where protocol semantics would otherwise be unclear
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-protocol-task-envelope', {
    type: 'deterministic',
    dependsOn: ['protocol-task-envelope'],
    command: `
if git diff --quiet -- ${PROTOCOL} ${CLIENT}; then
  echo "UNCHANGED: protocol/client"
  exit 1
fi
echo "UPDATED: protocol/client"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('sdk-task-facade', {
    agent: 'sdk-engineer',
    dependsOn: ['read-runtime-plan', 'verify-protocol-task-envelope'],
    task: `
Implement the SDK-facing task runtime APIs from the approved plan:
{{steps.read-runtime-plan.output}}

Edit only:
  - ${RELAY}

Required outcomes:
  - expose first-class task handles or equivalent task-oriented wrappers
  - add continuation-friendly APIs for pending messages / result inspection
  - preserve current agent-oriented APIs for existing callers
  - make the shape easy for workflows and communicate adapters to consume later
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-sdk-task-facade', {
    type: 'deterministic',
    dependsOn: ['sdk-task-facade'],
    command: `
if git diff --quiet -- ${RELAY}; then
  echo "UNCHANGED: relay facade"
  exit 1
fi
echo "UPDATED: relay facade"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('runner-task-adoption', {
    agent: 'runner-engineer',
    dependsOn: ['read-runtime-plan', 'verify-protocol-task-envelope', 'verify-sdk-task-facade'],
    task: `
Adopt the task runtime model inside the workflow engine using this plan:
{{steps.read-runtime-plan.output}}

Edit only:
  - ${RUNNER}

Required outcomes:
  - replace process-centric assumptions where practical with task-centric state
  - make pending messages and completion reasons available to workflow logic
  - reduce reliance on prompt-level self-termination text
  - preserve Relay's verification gates, retries, resume, and explicit DAG semantics
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-runner-task-adoption', {
    type: 'deterministic',
    dependsOn: ['runner-task-adoption'],
    command: `
if git diff --quiet -- ${RUNNER}; then
  echo "UNCHANGED: workflow runner"
  exit 1
fi
echo "UPDATED: workflow runner"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('broker-task-completion', {
    agent: 'broker-engineer',
    dependsOn: ['read-runtime-plan', 'verify-runner-task-adoption'],
    task: `
Implement the broker-side task runtime support from this plan:
{{steps.read-runtime-plan.output}}

Edit only:
  - ${MAIN_RS}
  - ${SUPERVISOR_RS}

Required outcomes:
  - make completion and release reasons broker-owned and observable
  - emit enough structured state so the SDK can stop depending on prompt conventions
  - preserve current agent spawn / release behavior for older clients
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-broker-task-completion', {
    type: 'deterministic',
    dependsOn: ['broker-task-completion'],
    command: `
if git diff --quiet -- ${MAIN_RS} ${SUPERVISOR_RS}; then
  echo "UNCHANGED: broker"
  exit 1
fi
echo "UPDATED: broker"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('task-runtime-tests', {
    agent: 'qa-engineer',
    dependsOn: [
      'verify-protocol-task-envelope',
      'verify-sdk-task-facade',
      'verify-runner-task-adoption',
      'verify-broker-task-completion',
    ],
    task: `
Add or update focused tests for the new task runtime.

Primary files:
  - ${FACADE_TEST}
  - ${RUNNER_TEST}

Add coverage for:
  - stable task handles
  - structured completion reasons / result payloads
  - pending message queue behavior
  - workflow runner integration with task-centric state

If a new focused test file is cleaner, create it under packages/sdk/src/__tests__/.
Keep tests narrow and deterministic.
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-task-runtime-tests', {
    type: 'deterministic',
    dependsOn: ['task-runtime-tests'],
    command: `
if git diff --quiet -- packages/sdk/src/__tests__; then
  echo "UNCHANGED: sdk tests"
  exit 1
fi
echo "UPDATED: sdk tests"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('lead-review-task-runtime', {
    agent: 'lead',
    dependsOn: [
      'verify-protocol-task-envelope',
      'verify-sdk-task-facade',
      'verify-runner-task-adoption',
      'verify-broker-task-completion',
      'verify-task-runtime-tests',
    ],
    task: `
Review the task runtime implementation against the original plan in ${PLAN_FILE}.

Review files:
  - ${PROTOCOL}
  - ${CLIENT}
  - ${RELAY}
  - ${RUNNER}
  - ${MAIN_RS}
  - ${SUPERVISOR_RS}
  - ${FACADE_TEST}
  - ${RUNNER_TEST}

Accept only if:
  - Relay is more task-centric without giving up explicit DAG control
  - completion ownership moved toward the manager/broker side
  - the public SDK shape is cleaner for continuation-heavy orchestration
  - tests cover the risky edge cases
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('task-runtime-check', {
    type: 'deterministic',
    dependsOn: ['lead-review-task-runtime'],
    command:
      'npx tsc -p packages/sdk/tsconfig.json --noEmit && ' +
      'npx vitest run packages/sdk/src/__tests__/facade.test.ts packages/sdk/src/__tests__/workflow-runner.test.ts',
    captureOutput: true,
    failOnError: true,
    timeoutMs: 1_200_000,
  })
  .run({
    cwd: process.cwd(),
    onEvent,
  });

console.log(JSON.stringify({ workflow: 'claude-task-runtime-campaign', status: result.status }, null, 2));
