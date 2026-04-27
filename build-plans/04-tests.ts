import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { workflow } = require('@agent-relay/sdk/workflows');

const REPO_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay-workflows';
const SPEC_PATH = 'workflows/meta-agent-flag/04-tests.spec.md';
const SDK_WORKFLOWS_DIR = 'packages/sdk/src/workflows';
const PERSONA_UTILS_PATH = `${SDK_WORKFLOWS_DIR}/persona-utils.ts`;
const WORKFLOW_GENERATOR_PATH = `${SDK_WORKFLOWS_DIR}/workflow-generator.ts`;
const CLI_PATH = `${SDK_WORKFLOWS_DIR}/cli.ts`;
const CONTEXT_HEURISTICS_PATH = `${SDK_WORKFLOWS_DIR}/context-heuristics.ts`;
const PERSONA_TEST_PATH = `${SDK_WORKFLOWS_DIR}/__tests__/persona-utils.test.ts`;
const WORKFLOW_GENERATOR_TEST_PATH = `${SDK_WORKFLOWS_DIR}/__tests__/workflow-generator.test.ts`;
const INTEGRATION_TEST_PATH = `${SDK_WORKFLOWS_DIR}/__tests__/workflow-generator.integration.test.ts`;
const SNAPSHOT_DIR = `${SDK_WORKFLOWS_DIR}/__tests__/__snapshots__`;

async function main() {
  const wf = workflow('phase-4-meta-agent-flag-tests')
    .description(
      'Create comprehensive unit and integration tests for Phase 1-3 --agent workflow SDK functionality'
    )
    .pattern('dag')
    .channel('wf-phase-4-meta-agent-flag-tests')
    .maxConcurrency(4)
    .timeout(3_600_000)
    .agent('persona-test-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused vitest test author for persona resolution utilities',
      retries: 2,
    })
    .agent('generator-test-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused vitest test author for workflow generator units and emitted source behavior',
      retries: 2,
    })
    .agent('integration-test-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused vitest integration test author for persona resolution to workflow generation',
      retries: 2,
    })
    .agent('sdk-reviewer', {
      cli: 'codex',
      preset: 'reviewer',
      role: 'Reviews Phase 4 tests for spec coverage, determinism, and regression value',
      retries: 1,
    });

  wf.step('guard-not-main', {
    type: 'deterministic',
    command: [
      'branch="$(git branch --show-current)"',
      'if [ "$branch" = "main" ]; then echo "Refusing to run Phase 4 workflow on main"; exit 1; fi',
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

  wf.step('read-phase-1-api', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [`test -f ${PERSONA_UTILS_PATH}`, `sed -n '1,360p' ${PERSONA_UTILS_PATH}`].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-phase-2-api', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [`test -f ${WORKFLOW_GENERATOR_PATH}`, `sed -n '1,520p' ${WORKFLOW_GENERATOR_PATH}`].join(
      ' && '
    ),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-phase-3-api', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `test -f ${CLI_PATH}`,
      `test -f ${CONTEXT_HEURISTICS_PATH}`,
      `grep -n "export .*parseAgentFlags\\|export .*buildWorkflowInput\\|function parseAgentFlags\\|function buildWorkflowInput" ${CLI_PATH} || true`,
      `grep -n "export .*inferContextFiles\\|function inferContextFiles" ${CONTEXT_HEURISTICS_PATH} || true`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-existing-tests', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `if test -f ${PERSONA_TEST_PATH}; then sed -n '1,260p' ${PERSONA_TEST_PATH}; else echo "No existing ${PERSONA_TEST_PATH}"; fi`,
      `if test -f ${WORKFLOW_GENERATOR_TEST_PATH}; then sed -n '1,320p' ${WORKFLOW_GENERATOR_TEST_PATH}; else echo "No existing ${WORKFLOW_GENERATOR_TEST_PATH}"; fi`,
      `if test -f ${INTEGRATION_TEST_PATH}; then sed -n '1,260p' ${INTEGRATION_TEST_PATH}; else echo "No existing ${INTEGRATION_TEST_PATH}"; fi`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-test-patterns', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `sed -n '1,200p' ${SDK_WORKFLOWS_DIR}/__tests__/template-resolver.test.ts`,
      `sed -n '1,180p' ${SDK_WORKFLOWS_DIR}/__tests__/verification.test.ts`,
      `sed -n '1,180p' ${SDK_WORKFLOWS_DIR}/__tests__/cli-session-collector.test.ts`,
      `find ${SDK_WORKFLOWS_DIR}/__tests__ -maxdepth 2 -type f -name "*.snap" -print | sed -n '1,80p'`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('write-persona-utils-tests', {
    agent: 'persona-test-writer',
    dependsOn: ['read-spec', 'read-phase-1-api', 'read-existing-tests', 'read-test-patterns'],
    task: `
You are writing Phase 4 persona utility tests. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Own only ${PERSONA_TEST_PATH}; do not revert or rewrite files outside that scope.

Spec:
{{steps.read-spec.output}}

Current persona utility API:
{{steps.read-phase-1-api.output}}

Existing tests and style examples:
{{steps.read-existing-tests.output}}
{{steps.read-test-patterns.output}}

Requirements:
1. Create or replace ${PERSONA_TEST_PATH} with the complete spec coverage for derivePreset(), derivePattern(), isAnalystIntent(), isPipelineIntent(), resolvePersonaByIdOrIntent(), DEFAULT_PERSONA_PROFILES, registry management, and resolvePersonaSelection().
2. Import exactly from '../persona-utils.js' with vitest describe/it/expect/beforeEach, and use type-only imports where appropriate.
3. Cover all production intents, all 10 default persona IDs, unregistered derived intents, profile hints, case/whitespace handling, edge inputs, and registry cache behavior.
4. Reset and initialize DEFAULT_PERSONA_PROFILES in each resolution-focused beforeEach so tests are order-independent.
5. Keep tests deterministic and avoid filesystem, network, snapshots, or external dependencies in this file.

Only edit ${PERSONA_TEST_PATH}. End your output with PERSONA_UTILS_PHASE4_TESTS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'PERSONA_UTILS_PHASE4_TESTS_DONE' },
    retries: 2,
  });

  wf.step('verify-persona-utils-tests-file', {
    type: 'deterministic',
    dependsOn: ['write-persona-utils-tests'],
    command: [
      `test -f ${PERSONA_TEST_PATH}`,
      `grep -q "derivePreset" ${PERSONA_TEST_PATH}`,
      `grep -q "derivePattern" ${PERSONA_TEST_PATH}`,
      `grep -q "resolvePersonaByIdOrIntent" ${PERSONA_TEST_PATH}`,
      `grep -q "resolvePersonaSelection" ${PERSONA_TEST_PATH}`,
      `grep -q "DEFAULT_PERSONA_PROFILES" ${PERSONA_TEST_PATH}`,
      `grep -q "ANALYST_INTENTS" ${PERSONA_TEST_PATH}`,
      `grep -q "PIPELINE_INTENTS" ${PERSONA_TEST_PATH}`,
      `grep -q "reviewer-v2" ${PERSONA_TEST_PATH}`,
      `grep -q "opencode-workflow-correctness" ${PERSONA_TEST_PATH}`,
      `grep -q "npm-provenance" ${PERSONA_TEST_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('write-workflow-generator-tests', {
    agent: 'generator-test-writer',
    dependsOn: [
      'read-spec',
      'read-phase-1-api',
      'read-phase-2-api',
      'read-existing-tests',
      'read-test-patterns',
    ],
    task: `
You are writing Phase 4 workflow generator unit tests. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Own only ${WORKFLOW_GENERATOR_TEST_PATH}; do not revert or rewrite files outside that scope.

Spec:
{{steps.read-spec.output}}

Current generator and persona APIs:
{{steps.read-phase-2-api.output}}
{{steps.read-phase-1-api.output}}

Existing tests and style examples:
{{steps.read-existing-tests.output}}
{{steps.read-test-patterns.output}}

Requirements:
1. Create or replace ${WORKFLOW_GENERATOR_TEST_PATH} with complete unit tests for slugify(), escapeTemplateString(), generateWorkflow(), all six emit phase functions, WorkflowMetadata, and edge cases from the spec.
2. Define createMinimalInput(), createFullInput(), and createPipelineInput() fixtures matching the spec and current exported types.
3. Assert emitted TypeScript structure without executing generated workflows.
4. Cover DAG and pipeline task shapes, skill/context/verification dependencies, output logging, escaping, metadata phase counts, estimated waves, and special/long/empty strings.
5. Keep tests deterministic, import from '../workflow-generator.js' and '../persona-utils.js', and avoid filesystem, network, snapshots, or external dependencies in this unit file.

Only edit ${WORKFLOW_GENERATOR_TEST_PATH}. End your output with WORKFLOW_GENERATOR_PHASE4_TESTS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'WORKFLOW_GENERATOR_PHASE4_TESTS_DONE' },
    retries: 2,
  });

  wf.step('verify-workflow-generator-tests-file', {
    type: 'deterministic',
    dependsOn: ['write-workflow-generator-tests'],
    command: [
      `test -f ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "generateWorkflow" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "emitBootstrapPhase" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "emitSkillPhase" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "emitContextPhase" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "emitTaskPhase" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "emitVerificationPhase" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "emitFinalPhase" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "slugify" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "escapeTemplateString" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "createPipelineInput" ${WORKFLOW_GENERATOR_TEST_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('write-integration-tests', {
    agent: 'integration-test-writer',
    dependsOn: [
      'read-spec',
      'read-phase-1-api',
      'read-phase-2-api',
      'read-phase-3-api',
      'read-existing-tests',
      'read-test-patterns',
    ],
    task: `
You are writing Phase 4 workflow generator integration tests. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Own only ${INTEGRATION_TEST_PATH} and generated Vitest snapshots under ${SNAPSHOT_DIR}; do not revert or rewrite files outside that scope.

Spec:
{{steps.read-spec.output}}

Current Phase 1-3 APIs:
{{steps.read-phase-1-api.output}}
{{steps.read-phase-2-api.output}}
{{steps.read-phase-3-api.output}}

Existing tests and snapshot style examples:
{{steps.read-existing-tests.output}}
{{steps.read-test-patterns.output}}

Requirements:
1. Create ${INTEGRATION_TEST_PATH} with the full persona resolution -> workflow generation integration coverage from the spec.
2. Include buildInput() helper, beforeEach registry reset/init, registered intent round-trips, unregistered derived intent round-trips, all 10 persona ID round-trips, and cross-pattern consistency.
3. Add the six generated workflow source snapshot tests from the spec using toMatchSnapshot().
4. Add metadata consistency tests and source validity tests for balanced braces/parentheses, no stray undefined/null values, and valid step names.
5. Keep tests deterministic; generated workflows are inspected as strings and must not be executed.

Only edit ${INTEGRATION_TEST_PATH} and Vitest snapshot files generated for it. End your output with WORKFLOW_GENERATOR_INTEGRATION_TESTS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'WORKFLOW_GENERATOR_INTEGRATION_TESTS_DONE' },
    retries: 2,
  });

  wf.step('verify-integration-tests-file', {
    type: 'deterministic',
    dependsOn: ['write-integration-tests'],
    command: [
      `test -f ${INTEGRATION_TEST_PATH}`,
      `grep -q "resolvePersonaByIdOrIntent" ${INTEGRATION_TEST_PATH}`,
      `grep -q "generateWorkflow" ${INTEGRATION_TEST_PATH}`,
      `grep -q "buildInput" ${INTEGRATION_TEST_PATH}`,
      `grep -q "toMatchSnapshot" ${INTEGRATION_TEST_PATH}`,
      `grep -q "requirements-analysis" ${INTEGRATION_TEST_PATH}`,
      `grep -q "tdd-enforcement" ${INTEGRATION_TEST_PATH}`,
      `grep -q "opencode-workflow-correctness" ${INTEGRATION_TEST_PATH}`,
      `grep -q "metadata consistency" ${INTEGRATION_TEST_PATH}`,
      `grep -q "generated source validity" ${INTEGRATION_TEST_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('run-persona-utils-tests', {
    type: 'deterministic',
    dependsOn: ['verify-persona-utils-tests-file'],
    command: `npx vitest run ${PERSONA_TEST_PATH} --reporter=verbose`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('run-workflow-generator-tests', {
    type: 'deterministic',
    dependsOn: ['verify-workflow-generator-tests-file'],
    command: `npx vitest run ${WORKFLOW_GENERATOR_TEST_PATH} --reporter=verbose`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('run-integration-tests-update-snapshots', {
    type: 'deterministic',
    dependsOn: ['verify-integration-tests-file'],
    command: `npx vitest run --update ${INTEGRATION_TEST_PATH} --reporter=verbose`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('verify-snapshots', {
    type: 'deterministic',
    dependsOn: ['run-integration-tests-update-snapshots'],
    command: [
      `test -d ${SNAPSHOT_DIR}`,
      `find ${SNAPSHOT_DIR} -type f -name "workflow-generator.integration.test.ts.snap" -print -quit | grep -q .`,
      `grep -R "minimal DAG workflow" ${SNAPSHOT_DIR}/workflow-generator.integration.test.ts.snap`,
      `grep -R "full security review workflow" ${SNAPSHOT_DIR}/workflow-generator.integration.test.ts.snap`,
      `grep -R "pipeline requirements analysis workflow" ${SNAPSHOT_DIR}/workflow-generator.integration.test.ts.snap`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('run-phase-4-tests', {
    type: 'deterministic',
    dependsOn: ['run-persona-utils-tests', 'run-workflow-generator-tests', 'verify-snapshots'],
    command: [
      `npx vitest run ${PERSONA_TEST_PATH} ${WORKFLOW_GENERATOR_TEST_PATH} ${INTEGRATION_TEST_PATH} --reporter=verbose`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('typecheck-sdk', {
    type: 'deterministic',
    dependsOn: ['run-phase-4-tests'],
    command: 'cd packages/sdk && npx tsc -p tsconfig.json --noEmit',
    captureOutput: true,
    failOnError: true,
  });

  wf.step('review-phase-4-tests', {
    agent: 'sdk-reviewer',
    dependsOn: ['read-spec', 'run-phase-4-tests', 'typecheck-sdk'],
    task: `
Review the Phase 4 test implementation. Do not edit files. Do not use Relaycast MCP tools or spawn sub-agents.

Spec:
{{steps.read-spec.output}}

Verify:
1. ${PERSONA_TEST_PATH} exhaustively covers persona derivation, resolution, registry behavior, defaults, wrapper behavior, and edge cases from the spec.
2. ${WORKFLOW_GENERATOR_TEST_PATH} covers slugify(), escapeTemplateString(), generateWorkflow(), all six emitters, metadata, DAG/pipeline branches, dependencies, output logging, and escaping edge cases.
3. ${INTEGRATION_TEST_PATH} covers resolution -> generation round-trips, all registered and derived intents, all 10 persona IDs, cross-pattern consistency, six snapshots, metadata consistency, and source validity.
4. Snapshot files were generated and reviewed as stable reference workflow output.
5. Tests are deterministic, do not execute generated workflows, introduce no dependencies, and pass along with SDK typecheck:
{{steps.run-phase-4-tests.output}}
{{steps.typecheck-sdk.output}}

Output REVIEW_PASS if acceptable; otherwise output REVIEW_FAIL with concrete blockers.
`.trim(),
    verification: { type: 'output_contains', value: 'REVIEW_PASS' },
    retries: 1,
  });

  wf.step('summarize-artifacts', {
    type: 'deterministic',
    dependsOn: ['review-phase-4-tests'],
    command: [
      `echo "Phase 4 tests workflow completed."`,
      `echo "Artifacts:"`,
      `echo "- ${PERSONA_TEST_PATH}"`,
      `echo "- ${WORKFLOW_GENERATOR_TEST_PATH}"`,
      `echo "- ${INTEGRATION_TEST_PATH}"`,
      `echo "- ${SNAPSHOT_DIR}/workflow-generator.integration.test.ts.snap"`,
      `git diff -- ${PERSONA_TEST_PATH} ${WORKFLOW_GENERATOR_TEST_PATH} ${INTEGRATION_TEST_PATH} ${SNAPSHOT_DIR} | sed -n '1,420p'`,
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
