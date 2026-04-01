/**
 * Workflow 03: Extract verification.ts from runner.ts
 * 
 * TDD extraction of the verification gate logic (~90 lines) from runner.ts.
 * Smallest, most self-contained module — extracted first as proof of pattern.
 *
 * Wave 2 — depends on Wave 1 plans being reviewed
 */
import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay';

async function main() {
  const result = await workflow('runner-extract-verification')
    .description('TDD extraction of verification gates from runner.ts')
    .pattern('dag')
    .channel('wf-extract-verification')
    .maxConcurrency(3)
    .timeout(3_600_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Designs the verification module API and writes characterization tests' })
    .agent('implementer', { cli: 'codex', preset: 'worker', role: 'Extracts code and wires imports' })
    .agent('reviewer', { cli: 'claude', preset: 'reviewer', role: 'Reviews extraction correctness and test coverage' })

    // Step 1: Read the verification section
    .step('read-verification', {
      type: 'deterministic',
      command: `cd ${ROOT} && sed -n '5859,5947p' packages/sdk/src/workflows/runner.ts && echo "---TYPES---" && grep -n "VerificationCheck\\|VerificationType" packages/sdk/src/workflows/types.ts`,
      captureOutput: true,
    })

    // Step 2: Read existing tests for verification
    .step('read-existing-tests', {
      type: 'deterministic',
      command: `cd ${ROOT} && grep -A20 "verification\\|verify" packages/sdk/src/__tests__/workflow-runner.test.ts | head -60`,
      captureOutput: true,
    })

    // Step 3: Write characterization tests FIRST (TDD red phase)
    .step('write-char-tests', {
      agent: 'architect',
      dependsOn: ['read-verification', 'read-existing-tests'],
      task: `Write characterization tests for the verification logic being extracted from runner.ts.

Current verification code:
{{steps.read-verification.output}}

Existing test coverage:
{{steps.read-existing-tests.output}}

Create file: ${ROOT}/packages/sdk/src/workflows/__tests__/verification.test.ts

Tests must cover:
1. exit_code verification — pass on exit 0, fail on non-zero
2. output_contains — case-sensitive substring match
3. file_exists — checks file presence at path
4. custom verification — callback function
5. Invalid/unknown verification type — falls through gracefully
6. Verification with no check defined — auto-pass

Use vitest. Import from '../verification.ts' (the module we'll create next).
These tests should FAIL initially (red phase) since the module doesn't exist yet.

Write the file to disk at the path above.
Keep output under 50 lines.
End with CHAR_TESTS_WRITTEN`,
      verification: { type: 'file_exists', value: 'packages/sdk/src/workflows/__tests__/verification.test.ts' },
    })

    // Step 4: Extract the verification module (TDD green phase)
    .step('extract-module', {
      agent: 'implementer',
      dependsOn: ['write-char-tests'],
      task: `Extract the verification logic from runner.ts into a new module.

Read these files:
- ${ROOT}/packages/sdk/src/workflows/runner.ts (lines 5859-5947 contain the verification section)
- ${ROOT}/packages/sdk/src/workflows/__tests__/verification.test.ts (tests to make pass)
- ${ROOT}/packages/sdk/src/workflows/types.ts (for VerificationCheck type)

Do these things:
1. Create ${ROOT}/packages/sdk/src/workflows/verification.ts with the extracted verification functions
2. Export a clean public API: runVerification(), checkExitCode(), checkOutputContains(), checkFileExists()
3. Update runner.ts to import from './verification.ts' instead of using inline code
4. Make sure the tests pass: cd ${ROOT} && npx vitest run packages/sdk/src/workflows/__tests__/verification.test.ts

The extracted module should be self-contained — no imports from runner.ts.
runner.ts should import from verification.ts, not the other way around.

End with EXTRACTION_COMPLETE`,
      verification: { type: 'output_contains', value: 'EXTRACTION_COMPLETE' },
    })

    // Step 5: Verify everything still compiles and tests pass
    .step('verify-green', {
      type: 'deterministic',
      dependsOn: ['extract-module'],
      command: `cd ${ROOT} && echo "=== New module ===" && wc -l packages/sdk/src/workflows/verification.ts && echo "=== Runner size ===" && wc -l packages/sdk/src/workflows/runner.ts && echo "=== New tests ===" && npx vitest run packages/sdk/src/workflows/__tests__/verification.test.ts 2>&1 | tail -10 && echo "=== Existing tests ===" && npx vitest run packages/sdk/src/__tests__/workflow-runner.test.ts 2>&1 | tail -10 && echo "=== TypeScript ===" && npx tsc --noEmit 2>&1 | tail -10 && echo "VERIFY_COMPLETE"`,
      captureOutput: true,
      failOnError: true,
    })

    // Step 6: Review the extraction
    .step('review-extraction', {
      agent: 'reviewer',
      dependsOn: ['verify-green'],
      task: `Review the verification module extraction.

Read these files:
- ${ROOT}/packages/sdk/src/workflows/verification.ts (new module)
- ${ROOT}/packages/sdk/src/workflows/__tests__/verification.test.ts (new tests)
- ${ROOT}/packages/sdk/src/workflows/runner.ts (check the import was wired correctly)

Verification results:
{{steps.verify-green.output}}

Check:
1. Is the extraction clean? No code duplication?
2. Are the imports correct in both directions?
3. Do ALL existing tests still pass?
4. Is the public API minimal and well-typed?
5. Any dead code left in runner.ts?

Verdict: APPROVED or NEEDS_FIXES with specific issues.
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
