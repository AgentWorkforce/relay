import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { workflow } = require('@agent-relay/sdk/workflows');

const REPO_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay-workflows';
const SPEC_PATH = 'workflows/meta-agent-flag/03-cli-agent-flag.spec.md';
const SDK_WORKFLOWS_DIR = 'packages/sdk/src/workflows';
const CLI_PATH = `${SDK_WORKFLOWS_DIR}/cli.ts`;
const CONTEXT_HEURISTICS_PATH = `${SDK_WORKFLOWS_DIR}/context-heuristics.ts`;
const CONTEXT_HEURISTICS_TEST_PATH = `${SDK_WORKFLOWS_DIR}/__tests__/context-heuristics.test.ts`;
const PERSONA_UTILS_PATH = `${SDK_WORKFLOWS_DIR}/persona-utils.ts`;
const WORKFLOW_GENERATOR_PATH = `${SDK_WORKFLOWS_DIR}/workflow-generator.ts`;
const WORKFLOWS_INDEX_PATH = `${SDK_WORKFLOWS_DIR}/index.ts`;
const RUNNER_PATH = `${SDK_WORKFLOWS_DIR}/runner.ts`;
const RUN_HELPER_PATH = `${SDK_WORKFLOWS_DIR}/run.ts`;

async function main() {
  const wf = workflow('phase-3-cli-agent-flag')
    .description('Implement CLI --agent mode, context heuristics, exports, and tests from the Phase 3 spec')
    .pattern('dag')
    .channel('wf-phase-3-cli-agent-flag')
    .maxConcurrency(4)
    .timeout(3_600_000)
    .agent('cli-implementer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused TypeScript SDK CLI implementer for relay-workflow agent mode',
      retries: 2,
    })
    .agent('context-implementer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused TypeScript SDK implementer for context inference utilities',
      retries: 2,
    })
    .agent('test-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused vitest test author for SDK workflow context heuristics',
      retries: 2,
    })
    .agent('sdk-reviewer', {
      cli: 'codex',
      preset: 'reviewer',
      role: 'Reviews CLI agent-mode implementation for spec conformance and regression risk',
      retries: 1,
    });

  wf.step('guard-not-main', {
    type: 'deterministic',
    command: [
      'branch="$(git branch --show-current)"',
      'if [ "$branch" = "main" ]; then echo "Refusing to run Phase 3 workflow on main"; exit 1; fi',
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

  wf.step('read-cli', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: `sed -n '1,560p' ${CLI_PATH}`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-phase-1-api', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [`test -f ${PERSONA_UTILS_PATH}`, `sed -n '1,280p' ${PERSONA_UTILS_PATH}`].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-phase-2-api', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [`test -f ${WORKFLOW_GENERATOR_PATH}`, `sed -n '1,320p' ${WORKFLOW_GENERATOR_PATH}`].join(
      ' && '
    ),
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

  wf.step('read-runner-execution-path', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [`sed -n '1688,1748p' ${RUNNER_PATH}`, `sed -n '1,140p' ${RUN_HELPER_PATH}`].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-test-patterns', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `sed -n '1,180p' ${SDK_WORKFLOWS_DIR}/__tests__/template-resolver.test.ts`,
      `sed -n '1,180p' ${SDK_WORKFLOWS_DIR}/__tests__/verification.test.ts`,
      `sed -n '1,180p' ${SDK_WORKFLOWS_DIR}/__tests__/cli-session-collector.test.ts`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('implement-context-heuristics', {
    agent: 'context-implementer',
    dependsOn: ['read-spec', 'read-phase-1-api'],
    task: `
You are implementing Phase 3 context inference for the --agent flag feature. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Other workflow workers may edit ${CLI_PATH}, ${WORKFLOWS_INDEX_PATH}, and tests. Own only ${CONTEXT_HEURISTICS_PATH}; do not revert or rewrite files outside that scope.

Create ${CONTEXT_HEURISTICS_PATH} from the Phase 3 spec.

Spec:
{{steps.read-spec.output}}

Phase 1 persona utility API:
{{steps.read-phase-1-api.output}}

Requirements:
1. Export ContextHeuristic, CandidateSpec, CONTEXT_HEURISTICS, and inferContextFiles().
2. Import ContextFileSpec as a type from './persona-utils.js'.
3. Implement all 13 intent mappings from the spec: review, security-review, architecture-plan, requirements-analysis, debugging, documentation, verification, test-strategy, tdd-enforcement, flake-investigation, npm-provenance, implement-frontend, and code-gen.
4. Implement literal file probing, command passthrough for git/npm/gh/cat candidates, glob probing, fallback context for package.json/tsconfig.json/README.md, case-insensitive intent matching, deterministic priority ordering, and the 10-file cap.
5. Do not add npm dependencies. If Node type definitions do not expose fs.promises.glob cleanly, implement globFiles() with Node built-ins such as readdir/stat instead of adding globby.
6. Keep commands relative to cwd and avoid shelling out during inference except by returning command strings as ContextFileSpec entries.
7. Use concise JSDoc for exported APIs and preserve the SDK style with .js import extensions.

Only edit ${CONTEXT_HEURISTICS_PATH}. End your output with CONTEXT_HEURISTICS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'CONTEXT_HEURISTICS_DONE' },
    retries: 2,
  });

  wf.step('verify-context-heuristics-file', {
    type: 'deterministic',
    dependsOn: ['implement-context-heuristics'],
    command: [
      `test -f ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "export interface ContextHeuristic" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "export interface CandidateSpec" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "export const CONTEXT_HEURISTICS" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "export async function inferContextFiles" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "security-review" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "architecture-plan" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "flake-investigation" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "npm-provenance" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "implement-frontend" ${CONTEXT_HEURISTICS_PATH}`,
      `grep -q "code-gen" ${CONTEXT_HEURISTICS_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('implement-cli-agent-mode', {
    agent: 'cli-implementer',
    dependsOn: [
      'read-spec',
      'read-cli',
      'read-phase-1-api',
      'read-phase-2-api',
      'read-runner-execution-path',
    ],
    task: `
You are implementing Phase 3 CLI --agent mode. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Other workflow workers may edit ${CONTEXT_HEURISTICS_PATH}, ${WORKFLOWS_INDEX_PATH}, and tests. Own only ${CLI_PATH}; do not revert or rewrite files outside that scope.

Update ${CLI_PATH} from the Phase 3 spec.

Spec:
{{steps.read-spec.output}}

Current CLI:
{{steps.read-cli.output}}

Phase 1 persona utility API:
{{steps.read-phase-1-api.output}}

Phase 2 workflow generator API:
{{steps.read-phase-2-api.output}}

Current runner/run execution path:
{{steps.read-runner-execution-path.output}}

Requirements:
1. Add all Phase 3 imports, including resolvePersonaByIdOrIntent(), generateWorkflow(), inferContextFiles(), writeFile(), and mkdir() as needed.
2. Update help output exactly for YAML mode, agent mode, and examples. Preserve existing YAML/resume behavior.
3. Update FLAGS_WITH_VALUES for --agent/-a, --profile/-p, --tier/-t, --context/-c, --verify/-v, --output/-o, --concurrency, and --timeout.
4. Export AgentModeFlags, parseAgentFlags(), and buildWorkflowInput(). Add getTaskDescriptionArg(), collectRepeatable(), getFlagValue(), validateFlagExclusivity(), runAgentMode(), printDryRunReport(), and a local slugify helper if needed.
5. Parse repeatable --context and --verify flags, validate tier/concurrency/timeout, support short flags, and throw clear Error messages for invalid values.
6. Validate agent-mode/YAML-mode mutual exclusivity before doing async work. Existing --resume, --workflow, --start-from, --previous-run-id, and --validate must error when combined with --agent.
7. buildWorkflowInput() must call resolvePersonaByIdOrIntent(), pass --profile as a PersonaProfile hint, use explicit --context paths when supplied, otherwise call inferContextFiles(selection.intent, cwd), map --verify commands, and forward outputPath/concurrency/timeout.
8. runAgentMode() must generate a workflow, write --output when supplied, print the dry-run report and avoid execution in --dry-run mode, and execute generated workflows in a way that works with the current runner/generator APIs. If generated.source is TypeScript, do not parse it as YAML unless the runner supports that shape; execute through the existing runnable workflow path while preserving WorkflowRunner-backed execution.
9. Ensure .agent-relay is created before writing any generated temporary workflow file.
10. Make ${CLI_PATH} import-safe before ${WORKFLOWS_INDEX_PATH} exports helpers from it: main() must only run when cli.ts is executed as the entry point, not when imported by the SDK index.
11. Keep YAML-mode DRY_RUN env var behavior unchanged.
12. Do not add npm dependencies and do not edit files outside ${CLI_PATH}.

Only edit ${CLI_PATH}. End your output with CLI_AGENT_MODE_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'CLI_AGENT_MODE_DONE' },
    retries: 2,
  });

  wf.step('verify-cli-agent-mode', {
    type: 'deterministic',
    dependsOn: ['implement-cli-agent-mode'],
    command: [
      `grep -q -- "relay-workflow \\"<task>\\" --agent <persona>" ${CLI_PATH}`,
      `grep -q -- "parseAgentFlags" ${CLI_PATH}`,
      `grep -q -- "buildWorkflowInput" ${CLI_PATH}`,
      `grep -q -- "runAgentMode" ${CLI_PATH}`,
      `grep -q -- "printDryRunReport" ${CLI_PATH}`,
      `grep -q -- "validateFlagExclusivity" ${CLI_PATH}`,
      `grep -q -- "resolvePersonaByIdOrIntent" ${CLI_PATH}`,
      `grep -q -- "generateWorkflow" ${CLI_PATH}`,
      `grep -q -- "inferContextFiles" ${CLI_PATH}`,
      `grep -q -- "--agent, -a" ${CLI_PATH}`,
      `grep -q -- "--dry-run" ${CLI_PATH}`,
      `grep -q -- "fileURLToPath(import.meta.url)" ${CLI_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('export-phase-3-api', {
    agent: 'cli-implementer',
    dependsOn: [
      'read-spec',
      'read-workflows-index',
      'verify-context-heuristics-file',
      'verify-cli-agent-mode',
    ],
    task: `
You are exporting Phase 3 SDK workflow APIs. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Other workflow workers may edit tests. Own only ${WORKFLOWS_INDEX_PATH}; do not revert or rewrite files outside that scope.

Update ${WORKFLOWS_INDEX_PATH} from the Phase 3 spec.

Spec:
{{steps.read-spec.output}}

Current index:
{{steps.read-workflows-index.output}}

Requirements:
1. Preserve every existing export in ${WORKFLOWS_INDEX_PATH}.
2. Add explicit exports for inferContextFiles, ContextHeuristic, and CandidateSpec from './context-heuristics.js'.
3. Add explicit exports for parseAgentFlags, buildWorkflowInput, and AgentModeFlags from './cli.js'.
4. Do not use export-star for cli.ts. Keep the export list narrow so importing the SDK does not expose main().
5. Do not edit files outside ${WORKFLOWS_INDEX_PATH}.

Only edit ${WORKFLOWS_INDEX_PATH}. End your output with PHASE_3_EXPORT_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'PHASE_3_EXPORT_DONE' },
    retries: 2,
  });

  wf.step('verify-index-export', {
    type: 'deterministic',
    dependsOn: ['export-phase-3-api'],
    command: [
      `grep -q "context-heuristics.js" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "inferContextFiles" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "ContextHeuristic" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "CandidateSpec" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "cli.js" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "parseAgentFlags" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "buildWorkflowInput" ${WORKFLOWS_INDEX_PATH}`,
      `grep -q "AgentModeFlags" ${WORKFLOWS_INDEX_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('write-context-heuristics-tests', {
    agent: 'test-writer',
    dependsOn: ['read-spec', 'read-test-patterns', 'verify-context-heuristics-file'],
    task: `
You are writing Phase 3 context heuristic tests. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Other workflow workers may edit ${CLI_PATH}, ${CONTEXT_HEURISTICS_PATH}, and ${WORKFLOWS_INDEX_PATH}. Own only ${CONTEXT_HEURISTICS_TEST_PATH}; do not revert or rewrite files outside that scope.

Create ${CONTEXT_HEURISTICS_TEST_PATH} with focused vitest coverage.

Spec:
{{steps.read-spec.output}}

Existing test style examples:
{{steps.read-test-patterns.output}}

Requirements:
1. Import describe, it, expect, beforeEach, and afterEach from vitest.
2. Use mkdtempSync, writeFileSync, mkdirSync, rmSync, path, and os for isolated temp projects.
3. Import inferContextFiles from '../context-heuristics.js'.
4. Cover the spec cases: fallback for unknown intent, empty result for review with no matches, tsconfig for architecture-plan, package.json for security-review, README for documentation, cap at 10 files, case-insensitive matching, and review intent git diff command.
5. Add at least one assertion that repeat matching files produce deterministic step names and cat commands.
6. Keep tests deterministic and avoid requiring a real network, GitHub CLI, or external dependencies.

Only edit ${CONTEXT_HEURISTICS_TEST_PATH}. End your output with CONTEXT_HEURISTICS_TESTS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'CONTEXT_HEURISTICS_TESTS_DONE' },
    retries: 2,
  });

  wf.step('verify-context-heuristics-test-file', {
    type: 'deterministic',
    dependsOn: ['write-context-heuristics-tests'],
    command: [
      `test -f ${CONTEXT_HEURISTICS_TEST_PATH}`,
      `grep -q "inferContextFiles" ${CONTEXT_HEURISTICS_TEST_PATH}`,
      `grep -q "mkdtempSync" ${CONTEXT_HEURISTICS_TEST_PATH}`,
      `grep -q "architecture-plan" ${CONTEXT_HEURISTICS_TEST_PATH}`,
      `grep -q "security-review" ${CONTEXT_HEURISTICS_TEST_PATH}`,
      `grep -q "documentation" ${CONTEXT_HEURISTICS_TEST_PATH}`,
      `grep -q "SECURITY-REVIEW" ${CONTEXT_HEURISTICS_TEST_PATH}`,
      `grep -q "git diff" ${CONTEXT_HEURISTICS_TEST_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('run-context-heuristics-tests', {
    type: 'deterministic',
    dependsOn: ['verify-context-heuristics-test-file'],
    command: `npx vitest run ${CONTEXT_HEURISTICS_TEST_PATH} --reporter=verbose`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('typecheck-sdk', {
    type: 'deterministic',
    dependsOn: ['verify-index-export', 'run-context-heuristics-tests'],
    command: 'cd packages/sdk && npx tsc -p tsconfig.json --noEmit',
    captureOutput: true,
    failOnError: true,
  });

  wf.step('review-phase-3', {
    agent: 'sdk-reviewer',
    dependsOn: [
      'read-spec',
      'verify-cli-agent-mode',
      'verify-index-export',
      'run-context-heuristics-tests',
      'typecheck-sdk',
    ],
    task: `
Review the Phase 3 CLI --agent integration. Do not edit files. Do not use Relaycast MCP tools or spawn sub-agents.

Spec:
{{steps.read-spec.output}}

Check:
1. ${CLI_PATH} preserves YAML mode, resume mode, validate mode, and existing DRY_RUN env var behavior when --agent is absent.
2. Agent mode activates only on --agent/-a and rejects YAML-only flags with clear messages.
3. parseAgentFlags() handles all long and short flags, repeatable --context/--verify, defaults, and invalid tier/concurrency/timeout values.
4. buildWorkflowInput() calls resolvePersonaByIdOrIntent(), applies profile hints, uses explicit context over heuristics, maps verifications, slugifies workflow names, and forwards output/concurrency/timeout.
5. runAgentMode() writes --output, supports --dry-run without execution, creates .agent-relay before temp writes, and uses an execution path compatible with generated workflow source.
6. ${CLI_PATH} is import-safe before ${WORKFLOWS_INDEX_PATH} exports parseAgentFlags() and buildWorkflowInput().
7. ${CONTEXT_HEURISTICS_PATH} implements every intent mapping, fallback, command candidates, literal and glob probing, case-insensitive matching, deterministic ordering, and the 10-file cap without new dependencies.
8. ${CONTEXT_HEURISTICS_TEST_PATH} covers the required behavior and the focused vitest run passed:
{{steps.run-context-heuristics-tests.output}}
9. SDK typecheck passed:
{{steps.typecheck-sdk.output}}

Output REVIEW_PASS if the implementation is acceptable; otherwise output REVIEW_FAIL with concrete blockers.
`.trim(),
    verification: { type: 'output_contains', value: 'REVIEW_PASS' },
    retries: 1,
  });

  wf.step('summarize-artifacts', {
    type: 'deterministic',
    dependsOn: ['review-phase-3'],
    command: [
      `echo "Phase 3 CLI agent flag workflow completed."`,
      `echo "Artifacts:"`,
      `echo "- ${CLI_PATH}"`,
      `echo "- ${CONTEXT_HEURISTICS_PATH}"`,
      `echo "- ${CONTEXT_HEURISTICS_TEST_PATH}"`,
      `echo "- ${WORKFLOWS_INDEX_PATH}"`,
      `git diff -- ${CLI_PATH} ${CONTEXT_HEURISTICS_PATH} ${CONTEXT_HEURISTICS_TEST_PATH} ${WORKFLOWS_INDEX_PATH} | sed -n '1,320p'`,
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
