/**
 * Workflow 04: Extract template-resolver.ts and channel-messenger.ts from runner.ts
 * 
 * TDD extraction of two mid-size modules in parallel (fan-out pattern).
 * Wave 2 — runs after plans are approved, parallel with 03.
 */
import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay';

async function main() {
  const result = await workflow('runner-extract-template-channel')
    .description('TDD extraction of template resolver and channel messenger from runner.ts')
    .pattern('dag')
    .channel('wf-extract-tmpl-chan')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Designs APIs and writes characterization tests for both modules' })
    .agent('tmpl-impl', { cli: 'codex', preset: 'worker', role: 'Extracts template-resolver module' })
    .agent('chan-impl', { cli: 'codex', preset: 'worker', role: 'Extracts channel-messenger module' })
    .agent('reviewer', { cli: 'claude', preset: 'reviewer', role: 'Reviews both extractions' })

    // Read both sections
    .step('read-sections', {
      type: 'deterministic',
      command: `cd ${ROOT} && echo "=== TEMPLATE RESOLVER (lines 1700-1808) ===" && sed -n '1700,1808p' packages/sdk/src/workflows/runner.ts && echo "=== CHANNEL MESSENGER (lines 6109-6371) ===" && sed -n '6109,6371p' packages/sdk/src/workflows/runner.ts`,
      captureOutput: true,
    })

    // Architect writes tests for BOTH modules
    .step('write-tests', {
      agent: 'architect',
      dependsOn: ['read-sections'],
      task: `Write characterization tests for two modules being extracted from runner.ts.

Source code:
{{steps.read-sections.output}}

Create TWO test files:

1. ${ROOT}/packages/sdk/src/workflows/__tests__/template-resolver.test.ts
   Tests: resolveTemplate with simple vars, step output injection, nested templates, missing vars, escaping

2. ${ROOT}/packages/sdk/src/workflows/__tests__/channel-messenger.test.ts  
   Tests: formatMessage truncation, sendStepOutput formatting, sendError formatting, channel name validation

Use vitest. Import from the modules that will be created.
Write BOTH files to disk.
Keep output under 40 lines.
End with TESTS_WRITTEN`,
      verification: { type: 'output_contains', value: 'TESTS_WRITTEN' },
    })

    // Extract template-resolver (parallel with channel)
    .step('extract-template', {
      agent: 'tmpl-impl',
      dependsOn: ['write-tests'],
      task: `Extract template resolution from runner.ts into a new module.

Read:
- ${ROOT}/packages/sdk/src/workflows/runner.ts (lines 1700-1808, the template variable resolution section)
- ${ROOT}/packages/sdk/src/workflows/__tests__/template-resolver.test.ts

Create ${ROOT}/packages/sdk/src/workflows/template-resolver.ts with:
- resolveTemplate(template: string, context: VariableContext): string
- resolveStepOutputRef(ref: string, stepOutputs: Map<string, string>): string
- Any helper functions needed

Update runner.ts to import from './template-resolver.ts'.
Run: cd ${ROOT} && npx vitest run packages/sdk/src/workflows/__tests__/template-resolver.test.ts
End with TEMPLATE_EXTRACTED`,
      verification: { type: 'output_contains', value: 'TEMPLATE_EXTRACTED' },
    })

    // Extract channel-messenger (parallel with template)
    .step('extract-channel', {
      agent: 'chan-impl',
      dependsOn: ['write-tests'],
      task: `Extract channel messaging from runner.ts into a new module.

Read:
- ${ROOT}/packages/sdk/src/workflows/runner.ts (lines 6109-6371, the channel messaging section)
- ${ROOT}/packages/sdk/src/workflows/__tests__/channel-messenger.test.ts

Create ${ROOT}/packages/sdk/src/workflows/channel-messenger.ts with:
- sendToChannel(relay, channel, message): Promise<void>
- formatStepOutput(stepName, output, maxLength?): string
- formatError(stepName, error): string
- truncateMessage(msg, maxLength): string

Update runner.ts to import from './channel-messenger.ts'.
Run: cd ${ROOT} && npx vitest run packages/sdk/src/workflows/__tests__/channel-messenger.test.ts
End with CHANNEL_EXTRACTED`,
      verification: { type: 'output_contains', value: 'CHANNEL_EXTRACTED' },
    })

    // Verify both + all existing tests
    .step('verify-all', {
      type: 'deterministic',
      dependsOn: ['extract-template', 'extract-channel'],
      command: `cd ${ROOT} && echo "=== Runner size ===" && wc -l packages/sdk/src/workflows/runner.ts && echo "=== New modules ===" && wc -l packages/sdk/src/workflows/template-resolver.ts packages/sdk/src/workflows/channel-messenger.ts && echo "=== All tests ===" && npx vitest run packages/sdk/src/workflows/__tests__/ packages/sdk/src/__tests__/workflow-runner.test.ts 2>&1 | tail -15 && echo "=== TypeScript ===" && npx tsc --noEmit 2>&1 | tail -10 && echo "VERIFY_COMPLETE"`,
      captureOutput: true,
      failOnError: true,
    })

    // Review both extractions
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['verify-all'],
      task: `Review both module extractions from runner.ts.

Read:
- ${ROOT}/packages/sdk/src/workflows/template-resolver.ts
- ${ROOT}/packages/sdk/src/workflows/channel-messenger.ts
- ${ROOT}/packages/sdk/src/workflows/runner.ts (check imports are wired)

Results: {{steps.verify-all.output}}

Check: clean extraction, no duplication, all tests pass, minimal public API.
Verdict: APPROVED or NEEDS_FIXES.
Keep under 30 lines.
End with REVIEW_COMPLETE`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .onError('continue')
    .run({ cwd: ROOT });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
