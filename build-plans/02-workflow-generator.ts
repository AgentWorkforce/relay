import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { workflow } = require('@agent-relay/sdk/workflows');

const REPO_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay-workflows';
const SPEC_PATH = 'workflows/meta-agent-flag/02-workflow-generator.spec.md';
const SDK_WORKFLOWS_DIR = 'packages/sdk/src/workflows';
const WORKFLOW_GENERATOR_PATH = `${SDK_WORKFLOWS_DIR}/workflow-generator.ts`;
const WORKFLOW_GENERATOR_TEST_PATH = `${SDK_WORKFLOWS_DIR}/__tests__/workflow-generator.test.ts`;
const PERSONA_UTILS_PATH = `${SDK_WORKFLOWS_DIR}/persona-utils.ts`;
const WORKFLOWS_INDEX_PATH = `${SDK_WORKFLOWS_DIR}/index.ts`;
const WORKFLOW_TYPES_PATH = `${SDK_WORKFLOWS_DIR}/types.ts`;
const WORKFLOW_BUILDER_PATH = `${SDK_WORKFLOWS_DIR}/builder.ts`;

async function main() {
  const wf = workflow('phase-2-workflow-generator')
    .description('Implement SDK workflow generator utilities and tests from the Phase 2 meta-agent flag spec')
    .pattern('dag')
    .channel('wf-phase-2-workflow-generator')
    .maxConcurrency(4)
    .timeout(3_600_000)
    .agent('generator-implementer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused TypeScript SDK implementer for pure workflow source generation utilities',
      retries: 2,
    })
    .agent('test-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused vitest test author for SDK workflow generator behavior and emitted source',
      retries: 2,
    })
    .agent('sdk-reviewer', {
      cli: 'codex',
      preset: 'reviewer',
      role: 'Reviews SDK generator implementation for spec conformance, source safety, and regression risk',
      retries: 1,
    });

  wf.step('guard-not-main', {
    type: 'deterministic',
    command: [
      'branch="$(git branch --show-current)"',
      'if [ "$branch" = "main" ]; then echo "Refusing to run Phase 2 workflow on main"; exit 1; fi',
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

  wf.step('read-persona-utils', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `if test -f ${PERSONA_UTILS_PATH}; then`,
      `sed -n '1,260p' ${PERSONA_UTILS_PATH};`,
      `else echo "${PERSONA_UTILS_PATH} is not present yet. Use the Phase 1 spec excerpt embedded in the Phase 2 spec for required types."; fi`,
    ].join(' '),
    captureOutput: true,
    failOnError: false,
  });

  wf.step('read-workflow-types', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: `sed -n '1,220p' ${WORKFLOW_TYPES_PATH}`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-builder-api', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: `sed -n '1,240p' ${WORKFLOW_BUILDER_PATH}`,
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
      `sed -n '1,160p' ${SDK_WORKFLOWS_DIR}/__tests__/verification.test.ts`,
      `sed -n '1,160p' packages/sdk/src/__tests__/builder-deterministic.test.ts 2>/dev/null || true`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('implement-workflow-generator', {
    agent: 'generator-implementer',
    dependsOn: ['read-spec', 'read-persona-utils', 'read-workflow-types', 'read-builder-api'],
    task: `
You are implementing Phase 2 of the --agent flag feature. Do not use Relaycast MCP tools or spawn sub-agents.

Create ${WORKFLOW_GENERATOR_PATH} from the Phase 2 spec.

Spec:
{{steps.read-spec.output}}

Current Phase 1 persona utilities, if present:
{{steps.read-persona-utils.output}}

Relevant workflow SDK types:
{{steps.read-workflow-types.output}}

Relevant WorkflowBuilder API:
{{steps.read-builder-api.output}}

Requirements:
1. Export GeneratedWorkflow, WorkflowMetadata, WorkflowGeneratorOptions, generateWorkflow(), and all phase emitters: emitBootstrapPhase(), emitSkillPhase(), emitContextPhase(), emitTaskPhase(), emitVerificationPhase(), emitFinalPhase().
2. Import AgentPreset and SwarmPattern as types from './types.js'. Import WorkflowGeneratorInput and related Phase 1 types from './persona-utils.js' using type imports.
3. Keep the module pure: no filesystem access, no process access, no network access, and no external npm dependencies.
4. Implement resolveOptions(), computeMetadata(), slugify(), escapeTemplateString(), composeTaskPrompt(), and any small local formatting helpers needed by the emitters.
5. Generated source must be a complete runnable TypeScript workflow file using import { workflow } from '@agent-relay/sdk/workflows', async main(), workflow(...), .description(), .pattern(), .channel(), .maxConcurrency(), .timeout(), .agent(), .step(), .onError('fail-fast'), .run(), and main().catch(...).
6. Use a single agent by default. The agent name must be '<intent>-agent' after slugifying the resolved intent. The cli defaults to 'claude' unless persona metadata provides a string cli override.
7. Emit skill install deterministic steps for every input.skillPlan.installs entry. Add a manifest read step when input.skillPlan.manifestPath is set.
8. Emit context deterministic steps with captureOutput: true. When skills exist, context steps depend on all skill and manifest steps; otherwise they remain independent.
9. Emit DAG task workflows as one execute-task step depending on all context steps. Emit pipeline workflows as analyze, synthesize, and validate steps with chained dependencies.
10. Emit verification deterministic steps with failOnError: true. DAG verification depends on execute-task; pipeline verification depends on validate.
11. Escape strings safely for generated single-quoted strings, shell command strings, and template literals. Backticks and dollar-brace sequences in user text must not break generated TypeScript.
12. Metadata must match the spec, including phase counts, hasSkills, hasVerification, agentCount, stepCount, and estimatedWaves. Count the manifest read step as a skills phase step.
13. Preserve existing code style: ES module imports with .js extensions, explicit exported functions, JSDoc on public APIs, and two-space formatting by default.

Only edit ${WORKFLOW_GENERATOR_PATH}. End your output with WORKFLOW_GENERATOR_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'WORKFLOW_GENERATOR_DONE' },
    retries: 2,
  });

  wf.step('verify-workflow-generator-file', {
    type: 'deterministic',
    dependsOn: ['implement-workflow-generator'],
    command: [
      `test -f ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "export function generateWorkflow" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "export function emitBootstrapPhase" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "export function emitSkillPhase" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "export function emitContextPhase" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "export function emitTaskPhase" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "export function emitVerificationPhase" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "export function emitFinalPhase" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "WorkflowMetadata" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "escapeTemplateString" ${WORKFLOW_GENERATOR_PATH}`,
      `grep -q "composeTaskPrompt" ${WORKFLOW_GENERATOR_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('export-workflow-generator', {
    agent: 'generator-implementer',
    dependsOn: ['read-spec', 'read-workflows-index', 'verify-workflow-generator-file'],
    task: `
Update ${WORKFLOWS_INDEX_PATH} to re-export the workflow generator public API.
Do not use Relaycast MCP tools or spawn sub-agents.

Spec:
{{steps.read-spec.output}}

Current index:
{{steps.read-workflows-index.output}}

Requirements:
1. Preserve every existing export in ${WORKFLOWS_INDEX_PATH}.
2. Add the explicit workflow-generator export block from the SDK Export Changes section.
3. Export from './workflow-generator.js'.
4. Include generateWorkflow, all six emit phase functions, and the GeneratedWorkflow, WorkflowMetadata, and WorkflowGeneratorOptions types.
5. Do not edit any file except ${WORKFLOWS_INDEX_PATH}.

End your output with WORKFLOW_GENERATOR_EXPORT_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'WORKFLOW_GENERATOR_EXPORT_DONE' },
    retries: 2,
  });

  wf.step('verify-index-export', {
    type: 'deterministic',
    dependsOn: ['export-workflow-generator'],
    command: [
      `grep -q "workflow-generator.js" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "generateWorkflow" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "emitBootstrapPhase" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "WorkflowGeneratorOptions" ${WORKFLOWS_INDEX_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('write-workflow-generator-tests', {
    agent: 'test-writer',
    dependsOn: ['read-spec', 'read-test-patterns', 'verify-workflow-generator-file'],
    task: `
Create ${WORKFLOW_GENERATOR_TEST_PATH} with focused vitest coverage for the Phase 2 workflow generator.
Do not use Relaycast MCP tools or spawn sub-agents.

Spec:
{{steps.read-spec.output}}

Existing test style examples:
{{steps.read-test-patterns.output}}

Requirements:
1. Import vitest describe, it, and expect.
2. Import generateWorkflow, all six emit phase functions, and exported types from '../workflow-generator.js'.
3. Import WorkflowGeneratorInput as a type from '../persona-utils.js'.
4. Provide createMinimalInput() and createFullInput() fixtures matching the spec.
5. Cover generateWorkflow minimal source, full source, metadata counts, workflow name, pattern, channel, maxConcurrency, timeout, and optional outputFile logging.
6. Cover emitBootstrapPhase header behavior, agent naming, preset, role from persona description, and role fallback.
7. Cover emitSkillPhase no skills, one skill, multiple independent skills, deterministic type, failOnError, and manifestPath behavior.
8. Cover emitContextPhase no context, captureOutput, skill dependencies, no dependencies without skills, and independent context steps.
9. Cover emitTaskPhase DAG execute-task output, pipeline analyze/synthesize/validate chain, context interpolation, retries, and exit_code verification.
10. Cover emitVerificationPhase no verifications, DAG dependency on execute-task, and pipeline dependency on validate.
11. Cover emitFinalPhase onError, run(), main().catch, process.exit(1), and outputFile logging.
12. Cover escaping edge cases for backticks, dollar-brace sequences, quotes, empty strings, long task descriptions, and special workflow names.
13. Keep tests deterministic and do not execute generated workflows.

Only edit ${WORKFLOW_GENERATOR_TEST_PATH}. End your output with WORKFLOW_GENERATOR_TESTS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'WORKFLOW_GENERATOR_TESTS_DONE' },
    retries: 2,
  });

  wf.step('verify-test-file', {
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
      `grep -q "createMinimalInput" ${WORKFLOW_GENERATOR_TEST_PATH}`,
      `grep -q "createFullInput" ${WORKFLOW_GENERATOR_TEST_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('run-workflow-generator-tests', {
    type: 'deterministic',
    dependsOn: ['verify-index-export', 'verify-test-file'],
    command: `npx vitest run ${WORKFLOW_GENERATOR_TEST_PATH} --reporter=verbose`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('typecheck-sdk', {
    type: 'deterministic',
    dependsOn: ['run-workflow-generator-tests'],
    command: 'cd packages/sdk && npx tsc -p tsconfig.json --noEmit',
    captureOutput: true,
    failOnError: true,
  });

  wf.step('review-phase-2', {
    agent: 'sdk-reviewer',
    dependsOn: ['read-spec', 'run-workflow-generator-tests', 'typecheck-sdk'],
    task: `
Review the Phase 2 workflow generator implementation. Do not edit files.
Do not use Relaycast MCP tools or spawn sub-agents.

Spec:
{{steps.read-spec.output}}

Check:
1. ${WORKFLOW_GENERATOR_PATH} is pure and has no external dependencies, filesystem access, process access, or network access.
2. The exported interfaces, helper functions, generateWorkflow(), and all six emit phase functions match the spec.
3. Generated workflows are complete TypeScript files that use the WorkflowBuilder API and include bootstrap, skills, context, task, verification, and final phases.
4. DAG and pipeline patterns produce the required task dependency shapes.
5. Skill manifest reads, context dependencies, verification dependencies, metadata counts, and estimated waves are correct.
6. User-provided strings are escaped safely for emitted TypeScript source.
7. ${WORKFLOWS_INDEX_PATH} re-exports the workflow generator public API.
8. ${WORKFLOW_GENERATOR_TEST_PATH} covers the required behavior without executing generated workflows.
9. Focused vitest and SDK typecheck passed:
{{steps.run-workflow-generator-tests.output}}
{{steps.typecheck-sdk.output}}

Output REVIEW_PASS if the implementation is acceptable; otherwise output REVIEW_FAIL with concrete blockers.
`.trim(),
    verification: { type: 'output_contains', value: 'REVIEW_PASS' },
    retries: 1,
  });

  wf.step('summarize-artifacts', {
    type: 'deterministic',
    dependsOn: ['review-phase-2'],
    command: [
      `echo "Phase 2 workflow generator workflow completed."`,
      `echo "Artifacts:"`,
      `echo "- ${WORKFLOW_GENERATOR_PATH}"`,
      `echo "- ${WORKFLOW_GENERATOR_TEST_PATH}"`,
      `echo "- ${WORKFLOWS_INDEX_PATH}"`,
      `git diff -- ${WORKFLOW_GENERATOR_PATH} ${WORKFLOW_GENERATOR_TEST_PATH} ${WORKFLOWS_INDEX_PATH} | sed -n '1,260p'`,
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
