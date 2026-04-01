/**
 * Workflow 05: Extract step-executor.ts from runner.ts
 * 
 * The biggest extraction — the step execution engine (~3100 lines).
 * Wave 3 — depends on verification, template, and channel being extracted first
 * (step-executor depends on all three).
 */
import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay';

async function main() {
  const result = await workflow('runner-extract-step-executor')
    .description('TDD extraction of the step execution engine from runner.ts')
    .pattern('dag')
    .channel('wf-extract-step-exec')
    .maxConcurrency(4)
    .timeout(5_400_000) // 90 min — this is the biggest extraction

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Designs step-executor API, writes characterization tests, guides extraction' })
    .agent('impl-1', { cli: 'codex', preset: 'worker', role: 'Extracts core step execution logic' })
    .agent('impl-2', { cli: 'codex', preset: 'worker', role: 'Extracts process spawning and output collection' })
    .agent('reviewer', { cli: 'claude', preset: 'reviewer', role: 'Reviews the extraction for correctness' })
    .agent('self-reflect', { cli: 'codex', preset: 'reviewer', role: 'Second reviewer — checks for missed edge cases' })

    // Read the step execution section
    .step('read-executor', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "=== STEP EXECUTOR (lines 2472-5585) — $(sed -n '2472,5585p' packages/sdk/src/workflows/runner.ts | wc -l) lines ===" && sed -n '2472,2550p' packages/sdk/src/workflows/runner.ts && echo "... (truncated — full section is ~3100 lines)" && echo "=== FUNCTION SIGNATURES ===" && sed -n '2472,5585p' packages/sdk/src/workflows/runner.ts | grep -n "async \|private \|public \|protected " | head -40 && echo "=== IDLE NUDGER (lines 5586-5858) ===" && sed -n '5586,5620p' packages/sdk/src/workflows/runner.ts`,
      captureOutput: true,
    })

    // Read already-extracted modules for dependency understanding
    .step('read-extracted', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "=== VERIFICATION API ===" && head -30 packages/sdk/src/workflows/verification.ts 2>/dev/null || echo "not yet extracted" && echo "=== TEMPLATE API ===" && head -30 packages/sdk/src/workflows/template-resolver.ts 2>/dev/null || echo "not yet extracted" && echo "=== CHANNEL API ===" && head -30 packages/sdk/src/workflows/channel-messenger.ts 2>/dev/null || echo "not yet extracted" && echo "=== TYPES ===" && cat packages/sdk/src/workflows/types.ts | head -80`,
      captureOutput: true,
    })

    // Architect designs the API and writes tests
    .step('design-and-test', {
      agent: 'architect',
      dependsOn: ['read-executor', 'read-extracted'],
      task: `Design the step-executor module API and write characterization tests.

Step executor section overview:
{{steps.read-executor.output}}

Already extracted modules:
{{steps.read-extracted.output}}

The step-executor is the largest extraction (~3100 lines). It should be split into TWO files:
1. ${ROOT}/packages/sdk/src/workflows/step-executor.ts — Core step lifecycle: schedule, start, monitor, complete
2. ${ROOT}/packages/sdk/src/workflows/process-spawner.ts — Process spawning, PTY management, output collection

Create test file: ${ROOT}/packages/sdk/src/workflows/__tests__/step-executor.test.ts

Tests must cover:
1. Deterministic step execution (shell command, exit code)
2. Non-interactive agent step (codex worker spawning)
3. Interactive agent step (claude lead spawning)  
4. Step timeout handling
5. Step dependency resolution (dependsOn)
6. Step output capture and storage
7. Step retry on failure
8. Process spawner — command building for each CLI type

Write the test file to disk. Design the public API but don't implement yet.
Keep output under 60 lines.
End with DESIGN_COMPLETE`,
      verification: { type: 'output_contains', value: 'DESIGN_COMPLETE' },
    })

    // Extract core step lifecycle (parallel)
    .step('extract-lifecycle', {
      agent: 'impl-1',
      dependsOn: ['design-and-test'],
      task: `Extract the step execution lifecycle from runner.ts.

Read:
- ${ROOT}/packages/sdk/src/workflows/runner.ts (lines 2472-4000 approximately — the step scheduling, starting, monitoring, and completion logic)
- ${ROOT}/packages/sdk/src/workflows/__tests__/step-executor.test.ts
- ${ROOT}/packages/sdk/src/workflows/types.ts

Create ${ROOT}/packages/sdk/src/workflows/step-executor.ts with:
- StepExecutor class or functions for: scheduleStep, startStep, monitorStep, completeStep
- Step state management (pending → running → completed/failed)
- Dependency resolution logic
- Retry logic
- Import verification, template-resolver, channel-messenger as dependencies

Update runner.ts to delegate step execution to the new module.
Run typecheck: cd ${ROOT} && npx tsc --noEmit 2>&1 | tail -20
End with LIFECYCLE_EXTRACTED`,
      verification: { type: 'output_contains', value: 'LIFECYCLE_EXTRACTED' },
    })

    // Extract process spawner (parallel)
    .step('extract-spawner', {
      agent: 'impl-2',
      dependsOn: ['design-and-test'],
      task: `Extract the process spawning logic from runner.ts.

Read:
- ${ROOT}/packages/sdk/src/workflows/runner.ts (lines 4000-5585 approximately — process spawning, PTY management, output collection, completion detection)
- ${ROOT}/packages/sdk/src/workflows/__tests__/step-executor.test.ts
- ${ROOT}/packages/sdk/src/cli-registry.ts (CLI configuration)

Create ${ROOT}/packages/sdk/src/workflows/process-spawner.ts with:
- buildCommand(cli, args, task): string[]
- spawnProcess(command, options): ChildProcess
- collectOutput(process): Promise<string>
- detectCompletion(output, verification): boolean

This module should be pure — no relay/channel dependencies.
Run typecheck: cd ${ROOT} && npx tsc --noEmit 2>&1 | tail -20
End with SPAWNER_EXTRACTED`,
      verification: { type: 'output_contains', value: 'SPAWNER_EXTRACTED' },
    })

    // Verify everything
    .step('verify-all', {
      type: 'deterministic',
      dependsOn: ['extract-lifecycle', 'extract-spawner'],
      command: `cd ${ROOT} && echo "=== Runner size ===" && wc -l packages/sdk/src/workflows/runner.ts && echo "=== New modules ===" && wc -l packages/sdk/src/workflows/step-executor.ts packages/sdk/src/workflows/process-spawner.ts 2>/dev/null && echo "=== All workflow tests ===" && npx vitest run packages/sdk/src/workflows/__tests__/ 2>&1 | tail -15 && echo "=== Existing runner tests ===" && npx vitest run packages/sdk/src/__tests__/workflow-runner.test.ts 2>&1 | tail -10 && echo "=== TypeScript ===" && npx tsc --noEmit 2>&1 | tail -10 && echo "VERIFY_COMPLETE"`,
      captureOutput: true,
      failOnError: true,
    })

    // First reviewer
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['verify-all'],
      task: `Review the step-executor extraction — the biggest refactor piece.

Read:
- ${ROOT}/packages/sdk/src/workflows/step-executor.ts
- ${ROOT}/packages/sdk/src/workflows/process-spawner.ts
- ${ROOT}/packages/sdk/src/workflows/runner.ts (verify it delegates correctly)

Results: {{steps.verify-all.output}}

Check: Is runner.ts significantly smaller? Are APIs clean? Tests pass? No circular deps?
Verdict: APPROVED or NEEDS_FIXES.
Keep under 30 lines.
End with REVIEW_COMPLETE`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    // Self-reflection — second reviewer catches what first missed
    .step('self-reflect', {
      agent: 'self-reflect',
      dependsOn: ['review'],
      task: `Second review of the step-executor extraction. Focus on what the first reviewer might have missed.

First review: {{steps.review.output}}

Read the actual files:
- ${ROOT}/packages/sdk/src/workflows/step-executor.ts
- ${ROOT}/packages/sdk/src/workflows/process-spawner.ts

Check specifically:
1. Error handling — are all error paths covered? Do failures propagate correctly?
2. Edge cases — empty output, process killed, timeout during spawn
3. State leaks — any mutable state shared between modules that shouldn't be?
4. Missing tests — any code paths not covered?

Keep under 25 lines.
End with SELF_REFLECT_COMPLETE`,
      verification: { type: 'output_contains', value: 'SELF_REFLECT_COMPLETE' },
    })

    .onError('continue')
    .run({ cwd: ROOT });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
