/**
 * Claude-Inspired Capability Isolation Campaign
 *
 * Goal:
 *   Add stronger per-worker capability scoping, inherited spawn policy, and
 *   ergonomic worktree isolation so Relay can keep its explicit workflows but
 *   gain safer worker specialization than Claude Code.
 */

import { workflow } from '../workflows/builder.js';
import type { WorkflowEvent } from '../workflows/runner.js';

const POLICY = 'packages/policy/src/agent-policy.ts';
const SPAWN_FROM_ENV = 'packages/sdk/src/spawn-from-env.ts';
const RELAY = 'packages/sdk/src/relay.ts';
const RUNNER = 'packages/sdk/src/workflows/runner.ts';
const SDK_PROTOCOL = 'packages/sdk/src/protocol.ts';
const POLICY_TEST = 'packages/policy/src/agent-policy.test.ts';
const SPAWN_TEST = 'packages/sdk/src/__tests__/spawn-from-env.test.ts';
const ORCH_TEST = 'packages/sdk/src/__tests__/orchestration-upgrades.test.ts';
const PLAN_FILE = '.agent-relay/plans/claude-capability-isolation.md';

function onEvent(event: WorkflowEvent): void {
  const ts = new Date().toISOString();
  if (event.type === 'step:started') console.log(`[${ts}] -> ${event.stepName}`);
  if (event.type === 'step:completed') console.log(`[${ts}] ok ${event.stepName}`);
  if (event.type === 'step:failed') console.error(`[${ts}] !! ${event.stepName}: ${event.error}`);
  if (event.type === 'run:failed') console.error(`[${ts}] run failed ${event.runId}: ${event.error}`);
}

const result = await workflow('claude-capability-isolation-campaign')
  .description(
    'Implement Claude-inspired capability isolation in Relay: per-worker allowlists, inherited spawn policy, ' +
      'and ergonomic worktree isolation without sacrificing broker observability or YAML/TS workflow repeatability.'
  )
  .pattern('dag')
  .channel('wf-claude-capability-isolation')
  .maxConcurrency(3)
  .timeout(10_800_000)
  .idleNudge({ nudgeAfterMs: 180_000, escalateAfterMs: 180_000, maxNudges: 2 })
  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })

  .agent('lead', {
    cli: 'claude',
    preset: 'lead',
    role:
      'Lead architect. Keeps Relay explicit and secure. Rejects any design that is policy-rich on paper but unenforced at runtime.',
    retries: 2,
  })
  .agent('isolation-analyst', {
    cli: 'claude',
    role:
      'Isolation analyst. Produces the implementation plan for capability scopes, spawn inheritance, and worktree ergonomics.',
    retries: 2,
  })
  .agent('policy-engineer', {
    cli: 'codex',
    role:
      'Policy engineer. Implements per-worker capability rules and inherited spawn policy semantics.',
    retries: 2,
  })
  .agent('sdk-engineer', {
    cli: 'codex',
    role:
      'SDK engineer. Threads capability metadata and spawn inheritance through the public SDK and spawn-from-env path.',
    retries: 2,
  })
  .agent('runner-engineer', {
    cli: 'codex',
    role:
      'Runner engineer. Adds ergonomic worktree isolation and capability-aware workflow execution.',
    retries: 2,
  })
  .agent('qa-engineer', {
    cli: 'codex',
    role:
      'QA engineer. Adds focused tests for capability rules, spawn inheritance, and isolation behavior.',
    retries: 2,
  })

  .step('analyze-capability-gaps', {
    agent: 'isolation-analyst',
    task: `
Study the current capability / spawn / isolation surface across:
  - ${POLICY}
  - ${SPAWN_FROM_ENV}
  - ${RELAY}
  - ${RUNNER}
  - ${SDK_PROTOCOL}

Write a concrete plan to ${PLAN_FILE}. The plan must define:
  1. per-worker capability allowlists / deny rules that survive spawn
  2. parent-to-child spawn inheritance semantics
  3. ergonomic worktree isolation for coding workers
  4. acceptance criteria and specific tests to add

Write the plan to disk. Do not only print it.
`,
    verification: { type: 'file_exists', value: PLAN_FILE },
    retries: 2,
  })
  .step('read-capability-plan', {
    type: 'deterministic',
    dependsOn: ['analyze-capability-gaps'],
    command: `cat ${PLAN_FILE}`,
    captureOutput: true,
    failOnError: true,
  })
  .step('policy-capability-rules', {
    agent: 'policy-engineer',
    dependsOn: ['read-capability-plan'],
    task: `
Implement the capability policy model from:
{{steps.read-capability-plan.output}}

Edit only:
  - ${POLICY}

Required outcomes:
  - express per-worker capability scopes clearly
  - make parent spawn inheritance and override rules explicit
  - keep the defaults safe and auditable
  - prefer runtime-enforceable shapes over purely descriptive config
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-policy-capability-rules', {
    type: 'deterministic',
    dependsOn: ['policy-capability-rules'],
    command: `
if git diff --quiet -- ${POLICY}; then
  echo "UNCHANGED: policy"
  exit 1
fi
echo "UPDATED: policy"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('sdk-spawn-inheritance', {
    agent: 'sdk-engineer',
    dependsOn: ['read-capability-plan', 'verify-policy-capability-rules'],
    task: `
Implement capability-aware spawn inheritance from the approved plan:
{{steps.read-capability-plan.output}}

Edit only:
  - ${SPAWN_FROM_ENV}
  - ${RELAY}
  - ${SDK_PROTOCOL}

Required outcomes:
  - thread capability metadata through spawn inputs
  - make parent-to-child inheritance explicit and testable
  - keep backwards compatibility for existing spawn callers
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-sdk-spawn-inheritance', {
    type: 'deterministic',
    dependsOn: ['sdk-spawn-inheritance'],
    command: `
if git diff --quiet -- ${SPAWN_FROM_ENV} ${RELAY} ${SDK_PROTOCOL}; then
  echo "UNCHANGED: sdk spawn inheritance"
  exit 1
fi
echo "UPDATED: sdk spawn inheritance"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('runner-worktree-isolation', {
    agent: 'runner-engineer',
    dependsOn: ['read-capability-plan', 'verify-sdk-spawn-inheritance'],
    task: `
Implement ergonomic worktree isolation and capability-aware execution from:
{{steps.read-capability-plan.output}}

Edit only:
  - ${RUNNER}

Required outcomes:
  - make isolated coding workers cheap to configure
  - keep Relay's explicit workflow / verification / resume semantics intact
  - ensure capability scopes remain visible to the runner
  - do not introduce hidden implicit behavior that the YAML/TS config cannot explain
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-runner-worktree-isolation', {
    type: 'deterministic',
    dependsOn: ['runner-worktree-isolation'],
    command: `
if git diff --quiet -- ${RUNNER}; then
  echo "UNCHANGED: runner isolation"
  exit 1
fi
echo "UPDATED: runner isolation"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('capability-isolation-tests', {
    agent: 'qa-engineer',
    dependsOn: [
      'verify-policy-capability-rules',
      'verify-sdk-spawn-inheritance',
      'verify-runner-worktree-isolation',
    ],
    task: `
Add focused tests for the new capability and isolation behavior.

Primary files:
  - ${POLICY_TEST}
  - ${SPAWN_TEST}
  - ${ORCH_TEST}

Cover:
  - allowed / denied capability combinations
  - parent-to-child spawn inheritance
  - worktree isolation configuration at workflow runtime
  - failure cases where an inherited child exceeds its allowed scope
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('verify-capability-isolation-tests', {
    type: 'deterministic',
    dependsOn: ['capability-isolation-tests'],
    command: `
if git diff --quiet -- packages/policy/src packages/sdk/src/__tests__; then
  echo "UNCHANGED: capability tests"
  exit 1
fi
echo "UPDATED: capability tests"
`,
    captureOutput: true,
    failOnError: true,
  })
  .step('lead-review-capability-isolation', {
    agent: 'lead',
    dependsOn: [
      'verify-policy-capability-rules',
      'verify-sdk-spawn-inheritance',
      'verify-runner-worktree-isolation',
      'verify-capability-isolation-tests',
    ],
    task: `
Review the capability isolation campaign against ${PLAN_FILE}.

Review files:
  - ${POLICY}
  - ${SPAWN_FROM_ENV}
  - ${RELAY}
  - ${RUNNER}
  - ${SDK_PROTOCOL}
  - ${POLICY_TEST}
  - ${SPAWN_TEST}
  - ${ORCH_TEST}

Accept only if:
  - worker capabilities are more explicit than Claude Code's tool scoping, not less
  - spawn inheritance is audit-friendly
  - worktree isolation is ergonomic for coding workflows
  - Relay still explains behavior via config and events, not hidden prompt magic
`,
    verification: { type: 'exit_code', value: '0' },
    retries: 2,
  })
  .step('capability-isolation-check', {
    type: 'deterministic',
    dependsOn: ['lead-review-capability-isolation'],
    command:
      'npm run test -w @agent-relay/policy && ' +
      'npx vitest run packages/sdk/src/__tests__/spawn-from-env.test.ts packages/sdk/src/__tests__/orchestration-upgrades.test.ts',
    captureOutput: true,
    failOnError: true,
    timeoutMs: 1_200_000,
  })
  .run({
    cwd: process.cwd(),
    onEvent,
  });

console.log(
  JSON.stringify({ workflow: 'claude-capability-isolation-campaign', status: result.status }, null, 2)
);
