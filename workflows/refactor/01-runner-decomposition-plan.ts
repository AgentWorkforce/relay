/**
 * Workflow 01: runner.ts Decomposition Plan
 * 
 * Analyzes the 6878-line WorkflowRunner god class and produces a detailed
 * decomposition plan with module boundaries, dependency graph, and test strategy.
 * 
 * Wave 1 — runs in parallel with 02-main-rs-decomposition-plan.ts
 */
import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay';

async function main() {
  const result = await workflow('runner-decomposition-plan')
    .description('Analyze runner.ts and produce a TDD decomposition plan')
    .pattern('dag')
    .channel('wf-runner-decomp-plan')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Analyzes the runner.ts god class and designs module boundaries' })
    .agent('test-strategist', { cli: 'claude', preset: 'worker', role: 'Designs the test-first approach for each extracted module' })
    .agent('reviewer', { cli: 'codex', preset: 'reviewer', role: 'Reviews the decomposition plan for completeness and risks' })

    // Step 1: Read the runner and catalog all sections
    .step('read-runner', {
      type: 'deterministic',
      command: `cd ${ROOT} && wc -l packages/sdk/src/workflows/runner.ts && echo "---SECTIONS---" && grep -n "// ──" packages/sdk/src/workflows/runner.ts && echo "---CLASSES---" && grep -n "^export class\\|^class " packages/sdk/src/workflows/runner.ts && echo "---EXPORTS---" && grep -n "^export " packages/sdk/src/workflows/runner.ts | head -30 && echo "---IMPORTS---" && head -85 packages/sdk/src/workflows/runner.ts && echo "---TESTS---" && ls -la packages/sdk/src/__tests__/workflow-runner*.test.ts 2>/dev/null && wc -l packages/sdk/src/__tests__/workflow-runner*.test.ts 2>/dev/null`,
      captureOutput: true,
    })

    // Step 2: Read the existing test file
    .step('read-tests', {
      type: 'deterministic',
      command: `cd ${ROOT} && head -100 packages/sdk/src/__tests__/workflow-runner.test.ts 2>/dev/null && echo "---DESCRIBE-BLOCKS---" && grep -n "describe\\|it(" packages/sdk/src/__tests__/workflow-runner.test.ts 2>/dev/null | head -40`,
      captureOutput: true,
    })

    // Step 3: Read related files to understand dependencies
    .step('read-deps', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "---TYPES---" && head -60 packages/sdk/src/workflows/types.ts && echo "---COORDINATOR---" && head -60 packages/sdk/src/workflows/coordinator.ts && echo "---TRAJECTORY---" && head -60 packages/sdk/src/workflows/trajectory.ts && echo "---CLI-REGISTRY---" && head -60 packages/sdk/src/cli-registry.ts && echo "---DIR-LISTING---" && ls packages/sdk/src/workflows/`,
      captureOutput: true,
    })

    // Step 4: Architect designs the decomposition plan
    .step('design-plan', {
      agent: 'architect',
      dependsOn: ['read-runner', 'read-tests', 'read-deps'],
      task: `You are decomposing the WorkflowRunner god class (6878 lines) into focused modules.

Current sections in runner.ts (from grep):
{{steps.read-runner.output}}

Existing tests:
{{steps.read-tests.output}}

Related files:
{{steps.read-deps.output}}

Design a decomposition plan that extracts runner.ts into these modules:

1. **step-executor.ts** — Step execution engine (lines ~2472-5585). The core execute-step logic, process spawning, output collection, completion detection.
2. **template-resolver.ts** — Template variable resolution (lines ~1700-1808). The {{steps.X.output}} and {{var}} expansion.
3. **verification.ts** — Verification gates (lines ~5859-5947). exit_code, output_contains, file_exists, custom checks.
4. **channel-messenger.ts** — Channel messaging (lines ~6109-6371). Relay channel message sending, formatting, truncation.
5. **idle-nudger.ts** — Idle nudging logic (lines ~5586-5858). Timeout detection, nudge message generation, escalation.
6. **parser-validator.ts** — Parsing & validation (lines ~1185-1250). YAML/TS workflow parsing, step validation, cycle detection.
7. **dry-runner.ts** — Dry-run simulation (lines ~1251-1699). Simulated execution for --dry-run mode.
8. **relaycast-provisioner.ts** — Relaycast auto-provisioning (lines ~1012-1169). API key resolution, workspace creation.
9. **runner.ts** (slimmed) — Orchestration shell that imports and wires the above modules. Should be <800 lines.

For EACH module, specify:
- Exact line ranges to extract
- Public API (exported functions/classes)
- Dependencies on other modules
- What tests exist today and what new tests are needed
- Migration strategy (how to extract without breaking existing tests)

Output format: structured markdown. Keep under 80 lines.
End with DECOMPOSITION_PLAN_COMPLETE`,
      verification: { type: 'output_contains', value: 'DECOMPOSITION_PLAN_COMPLETE' },
    })

    // Step 5: Test strategist designs TDD approach
    .step('design-tests', {
      agent: 'test-strategist',
      dependsOn: ['design-plan'],
      task: `Based on this decomposition plan:
{{steps.design-plan.output}}

Design the test-first strategy for extracting each module from runner.ts.

For each of the 8 extracted modules:
1. List the test file name (e.g., step-executor.test.ts)
2. List 3-5 key test cases that must pass BEFORE extraction (characterization tests)
3. List 3-5 new unit tests for the extracted module
4. Specify the test command to verify each module in isolation
5. Define the "green bar" criteria — what must pass before moving to the next module

Also specify the extraction ORDER (which module to extract first, second, etc.) based on:
- Fewest dependencies = extract first
- Most self-contained = extract first
- Existing test coverage = extract first

Keep output under 60 lines.
End with TEST_STRATEGY_COMPLETE`,
      verification: { type: 'output_contains', value: 'TEST_STRATEGY_COMPLETE' },
    })

    // Step 6: Reviewer validates the plan
    .step('review-plan', {
      agent: 'reviewer',
      dependsOn: ['design-plan', 'design-tests'],
      task: `Review these two documents for the runner.ts decomposition:

DECOMPOSITION PLAN:
{{steps.design-plan.output}}

TEST STRATEGY:
{{steps.design-tests.output}}

Check for:
1. Are all 6878 lines accounted for? No orphaned code?
2. Are circular dependencies between extracted modules avoided?
3. Is the extraction order safe (no breaking intermediate states)?
4. Are the test criteria sufficient to catch regressions?
5. Any risks with the public API changes?

Provide a verdict: APPROVED, APPROVED_WITH_CHANGES, or REJECTED.
List any required changes.
Keep under 40 lines.
End with REVIEW_COMPLETE`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    // Step 7: Write the plan to disk
    .step('save-plan', {
      type: 'deterministic',
      dependsOn: ['review-plan'],
      command: `cd ${ROOT} && mkdir -p docs/refactor && echo "Plan saved to .agent-relay/step-outputs/" && echo "PLAN_SAVED"`,
      captureOutput: true,
      failOnError: true,
    })

    .onError('continue')
    .run({ cwd: ROOT });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
