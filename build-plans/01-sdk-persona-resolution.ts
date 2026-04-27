import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { workflow } = require('@agent-relay/sdk/workflows');

const REPO_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay-workflows';
const SPEC_PATH = 'workflows/meta-agent-flag/01-sdk-persona-resolution.spec.md';
const SDK_WORKFLOWS_DIR = 'packages/sdk/src/workflows';
const PERSONA_UTILS_PATH = `${SDK_WORKFLOWS_DIR}/persona-utils.ts`;
const PERSONA_TEST_PATH = `${SDK_WORKFLOWS_DIR}/__tests__/persona-utils.test.ts`;
const WORKFLOWS_INDEX_PATH = `${SDK_WORKFLOWS_DIR}/index.ts`;

async function main() {
  const wf = workflow('phase-1-sdk-persona-resolution')
    .description('Implement SDK persona resolution utilities and tests from the Phase 1 meta-agent flag spec')
    .pattern('dag')
    .channel('wf-phase-1-sdk-persona-resolution')
    .maxConcurrency(4)
    .timeout(3_600_000)
    .agent('sdk-implementer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused TypeScript SDK implementer for workflow utilities',
      retries: 2,
    })
    .agent('test-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused vitest test author for SDK workflow utilities',
      retries: 2,
    })
    .agent('sdk-reviewer', {
      cli: 'codex',
      preset: 'reviewer',
      role: 'Reviews SDK utility implementation for spec conformance and regression risk',
      retries: 1,
    });

  wf.step('guard-not-main', {
    type: 'deterministic',
    command: [
      'branch="$(git branch --show-current)"',
      'if [ "$branch" = "main" ]; then echo "Refusing to run Phase 1 workflow on main"; exit 1; fi',
      'echo "Running on branch: ${branch:-detached}"',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-spec', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: `cat ${SPEC_PATH}`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-sdk-types', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: `sed -n '1,180p' ${SDK_WORKFLOWS_DIR}/types.ts`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-workflows-index', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: `cat ${WORKFLOWS_INDEX_PATH}`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-test-patterns', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `sed -n '1,180p' ${SDK_WORKFLOWS_DIR}/__tests__/template-resolver.test.ts`,
      `sed -n '1,120p' ${SDK_WORKFLOWS_DIR}/__tests__/verification.test.ts`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('implement-persona-utils', {
    agent: 'sdk-implementer',
    dependsOn: ['read-spec', 'read-sdk-types'],
    task: `
You are implementing Phase 1 of the --agent flag feature. Do not use Relaycast MCP tools or spawn sub-agents.

Create ${PERSONA_UTILS_PATH} from the Phase 1 spec.

Spec:
{{steps.read-spec.output}}

Relevant existing workflow SDK types:
{{steps.read-sdk-types.output}}

Requirements:
1. Import only \`AgentPreset\` and \`SwarmPattern\` from \`./types.js\` using type imports.
2. Export ANALYST_INTENTS, PIPELINE_INTENTS, DEFAULT_PERSONA_PROFILES, all specified interfaces/types, registry helpers, derivation helpers, resolvePersonaByIdOrIntent(), and resolvePersonaSelection().
3. Use a module-level in-memory PersonaRegistry with case-insensitive by-id and by-intent lookups.
4. Implement lazy getPersonaIdToIntentMap() cache invalidation on register/init/reset.
5. Auto-initialize the registry with the 10 default profiles on import.

Only edit ${PERSONA_UTILS_PATH}. End your output with PERSONA_UTILS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'PERSONA_UTILS_DONE' },
    retries: 2,
  });

  wf.step('verify-persona-utils-file', {
    type: 'deterministic',
    dependsOn: ['implement-persona-utils'],
    command: [
      `test -f ${PERSONA_UTILS_PATH}`,
      `grep -q "export function derivePreset" ${PERSONA_UTILS_PATH}`,
      `grep -q "export function derivePattern" ${PERSONA_UTILS_PATH}`,
      `grep -q "export function resolvePersonaByIdOrIntent" ${PERSONA_UTILS_PATH}`,
      `grep -q "export function resolvePersonaSelection" ${PERSONA_UTILS_PATH}`,
      `grep -q "DEFAULT_PERSONA_PROFILES" ${PERSONA_UTILS_PATH}`,
      `grep -q "reviewer-v1" ${PERSONA_UTILS_PATH}`,
      `grep -q "code-worker-v1" ${PERSONA_UTILS_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('export-persona-utils', {
    agent: 'sdk-implementer',
    dependsOn: ['read-spec', 'read-workflows-index', 'verify-persona-utils-file'],
    task: `
You are exporting the Phase 1 persona utility public API. Do not use Relaycast MCP tools or spawn sub-agents.

Update ${WORKFLOWS_INDEX_PATH} to re-export the persona-utils public API.

Spec export block:
{{steps.read-spec.output}}

Current index:
{{steps.read-workflows-index.output}}

Requirements:
1. Preserve every existing export in ${WORKFLOWS_INDEX_PATH}.
2. Add the explicit export block from the "SDK Export Changes" section of the spec.
3. Export from \`./persona-utils.js\`.
4. Do not modify any other file.

End your output with INDEX_EXPORT_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'INDEX_EXPORT_DONE' },
    retries: 2,
  });

  wf.step('verify-index-export', {
    type: 'deterministic',
    dependsOn: ['export-persona-utils'],
    command: [
      `grep -q "persona-utils.js" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "resolvePersonaByIdOrIntent" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "WorkflowGeneratorInput" ${WORKFLOWS_INDEX_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('write-persona-utils-tests', {
    agent: 'test-writer',
    dependsOn: ['read-spec', 'read-test-patterns', 'verify-persona-utils-file'],
    task: `
You are writing Phase 1 persona utility tests. Do not use Relaycast MCP tools or spawn sub-agents.

Create ${PERSONA_TEST_PATH} with focused vitest coverage for persona-utils.

Spec:
{{steps.read-spec.output}}

Existing test style examples:
{{steps.read-test-patterns.output}}

Requirements:
1. Import from \`../persona-utils.js\` and use vitest describe/it/expect/beforeEach.
2. Cover derivePreset(), derivePattern(), isAnalystIntent(), and isPipelineIntent().
3. Cover intent, persona ID, fallback, profile hint, uppercase ID, and mixed-case intent resolution.
4. Reset and initialize DEFAULT_PERSONA_PROFILES in beforeEach.
5. Validate all 10 default persona IDs plus preset/pattern validity.

Only edit ${PERSONA_TEST_PATH}. End your output with PERSONA_TESTS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'PERSONA_TESTS_DONE' },
    retries: 2,
  });

  wf.step('verify-test-file', {
    type: 'deterministic',
    dependsOn: ['write-persona-utils-tests'],
    command: [
      `test -f ${PERSONA_TEST_PATH}`,
      `grep -q "derivePreset" ${PERSONA_TEST_PATH}`,
      `grep -q "derivePattern" ${PERSONA_TEST_PATH}`,
      `grep -q "resolvePersonaByIdOrIntent" ${PERSONA_TEST_PATH}`,
      `grep -q "reviewer-v2" ${PERSONA_TEST_PATH}`,
      `grep -q "requirements-analysis" ${PERSONA_TEST_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('run-persona-utils-tests', {
    type: 'deterministic',
    dependsOn: ['verify-index-export', 'verify-test-file'],
    command: `npx vitest run ${PERSONA_TEST_PATH} --reporter=verbose`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('typecheck-sdk', {
    type: 'deterministic',
    dependsOn: ['run-persona-utils-tests'],
    command: 'cd packages/sdk && npx tsc -p tsconfig.json --noEmit',
    captureOutput: true,
    failOnError: true,
  });

  wf.step('review-phase-1', {
    agent: 'sdk-reviewer',
    dependsOn: ['run-persona-utils-tests', 'typecheck-sdk'],
    task: `
You are reviewing Phase 1 persona resolution artifacts. Do not use Relaycast MCP tools or spawn sub-agents.

Review the Phase 1 persona resolution implementation. Do not edit files.

Spec:
{{steps.read-spec.output}}

Check:
1. ${PERSONA_UTILS_PATH} has no external dependencies or filesystem access.
2. derivePreset(), derivePattern(), registry helpers, and resolvePersonaByIdOrIntent() match the spec.
3. ${WORKFLOWS_INDEX_PATH} re-exports the full persona-utils public API.
4. ${PERSONA_TEST_PATH} covers the required behaviors and isolation reset.
5. Focused vitest and SDK typecheck passed:
{{steps.run-persona-utils-tests.output}}
{{steps.typecheck-sdk.output}}

Output REVIEW_PASS if the implementation is acceptable; otherwise output REVIEW_FAIL with concrete blockers.
`.trim(),
    verification: { type: 'output_contains', value: 'REVIEW_PASS' },
    retries: 1,
  });

  wf.step('summarize-artifacts', {
    type: 'deterministic',
    dependsOn: ['review-phase-1'],
    command: [
      `echo "Phase 1 persona resolution workflow completed."`,
      `echo "Artifacts:"`,
      `echo "- ${PERSONA_UTILS_PATH}"`,
      `echo "- ${PERSONA_TEST_PATH}"`,
      `echo "- ${WORKFLOWS_INDEX_PATH}"`,
      `git diff -- ${PERSONA_UTILS_PATH} ${PERSONA_TEST_PATH} ${WORKFLOWS_INDEX_PATH} | sed -n '1,220p'`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  const result = await wf.onError('retry', { maxRetries: 2, retryDelayMs: 10_000 }).run({
    cwd: REPO_ROOT,
  });

  if ('status' in result) {
    console.log(`Result: ${result.status}`);
  } else {
    console.log('Dry run completed.');
    return;
  }

  if (result.status !== 'completed') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
