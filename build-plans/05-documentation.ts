import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { workflow } = require('@agent-relay/sdk/workflows');

const REPO_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay-workflows';
const SPEC_PATH = 'workflows/meta-agent-flag/05-documentation.spec.md';
const README_PATH = 'README.md';
const SDK_WORKFLOWS_DIR = 'packages/sdk/src/workflows';
const CLI_PATH = `${SDK_WORKFLOWS_DIR}/cli.ts`;
const PERSONA_UTILS_PATH = `${SDK_WORKFLOWS_DIR}/persona-utils.ts`;
const WORKFLOW_GENERATOR_PATH = `${SDK_WORKFLOWS_DIR}/workflow-generator.ts`;
const CONTEXT_HEURISTICS_PATH = `${SDK_WORKFLOWS_DIR}/context-heuristics.ts`;
const WORKFLOWS_INDEX_PATH = `${SDK_WORKFLOWS_DIR}/index.ts`;
const AGENT_FLAG_DOC_PATH = 'docs/agent-flag.md';
const AGENT_FLAG_MDX_PATH = 'web/content/docs/agent-flag.mdx';
const SDK_REFERENCE_DOC_PATH = 'docs/reference-sdk.md';
const SDK_REFERENCE_MDX_PATH = 'web/content/docs/reference-sdk.mdx';
const REFERENCE_WORKFLOWS_MDX_PATH = 'web/content/docs/reference-workflows.mdx';

async function main() {
  const wf = workflow('phase-5-documentation')
    .description(
      'Document the --agent flag feature in README, CLI help, SDK reference, and docs site mirrors'
    )
    .pattern('dag')
    .channel('wf-phase-5-documentation')
    .maxConcurrency(4)
    .timeout(3_600_000)
    .agent('readme-doc-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused documentation writer for README CLI feature docs',
      retries: 2,
    })
    .agent('cli-help-updater', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused TypeScript CLI help text updater',
      retries: 2,
    })
    .agent('agent-guide-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused docs writer for markdown and MDX agent-mode guides',
      retries: 2,
    })
    .agent('sdk-reference-writer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Focused API reference writer for SDK markdown and MDX mirrors',
      retries: 2,
    })
    .agent('docs-reviewer', {
      cli: 'codex',
      preset: 'reviewer',
      role: 'Reviews Phase 5 documentation for spec conformance, docs sync, and runnable examples',
      retries: 1,
    });

  wf.step('guard-not-main', {
    type: 'deterministic',
    command: [
      'branch="$(git branch --show-current)"',
      'if [ "$branch" = "main" ]; then echo "Refusing to run Phase 5 workflow on main"; exit 1; fi',
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

  wf.step('read-readme', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: `sed -n '1,260p' ${README_PATH}`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-cli', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: `sed -n '1,520p' ${CLI_PATH}`,
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-phase-api-surface', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `if test -f ${PERSONA_UTILS_PATH}; then sed -n '1,380p' ${PERSONA_UTILS_PATH}; else echo "Missing ${PERSONA_UTILS_PATH}; Phase 1 may not have run yet."; fi`,
      `if test -f ${WORKFLOW_GENERATOR_PATH}; then sed -n '1,420p' ${WORKFLOW_GENERATOR_PATH}; else echo "Missing ${WORKFLOW_GENERATOR_PATH}; Phase 2 may not have run yet."; fi`,
      `if test -f ${CONTEXT_HEURISTICS_PATH}; then sed -n '1,300p' ${CONTEXT_HEURISTICS_PATH}; else echo "Missing ${CONTEXT_HEURISTICS_PATH}; Phase 3 may not have run yet."; fi`,
      `if test -f ${WORKFLOWS_INDEX_PATH}; then sed -n '1,240p' ${WORKFLOWS_INDEX_PATH}; else echo "Missing ${WORKFLOWS_INDEX_PATH}."; fi`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-existing-docs', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `if test -f ${AGENT_FLAG_DOC_PATH}; then sed -n '1,360p' ${AGENT_FLAG_DOC_PATH}; else echo "No existing ${AGENT_FLAG_DOC_PATH}"; fi`,
      `if test -f ${AGENT_FLAG_MDX_PATH}; then sed -n '1,360p' ${AGENT_FLAG_MDX_PATH}; else echo "No existing ${AGENT_FLAG_MDX_PATH}"; fi`,
      `if test -f ${SDK_REFERENCE_DOC_PATH}; then sed -n '1,420p' ${SDK_REFERENCE_DOC_PATH}; else echo "No existing ${SDK_REFERENCE_DOC_PATH}"; fi`,
      `if test -f ${SDK_REFERENCE_MDX_PATH}; then sed -n '1,420p' ${SDK_REFERENCE_MDX_PATH}; else echo "No existing ${SDK_REFERENCE_MDX_PATH}"; fi`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-doc-style', {
    type: 'deterministic',
    dependsOn: ['guard-not-main'],
    command: [
      `sed -n '1,180p' docs/introduction.md`,
      `sed -n '1,220p' web/content/docs/cli-workflows.mdx`,
      `if test -f ${REFERENCE_WORKFLOWS_MDX_PATH}; then sed -n '1,260p' ${REFERENCE_WORKFLOWS_MDX_PATH}; else echo "No ${REFERENCE_WORKFLOWS_MDX_PATH} style reference."; fi`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('update-cli-help-text', {
    agent: 'cli-help-updater',
    dependsOn: ['read-spec', 'read-cli', 'read-phase-api-surface'],
    task: `
You are implementing Phase 5 CLI help documentation. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Own only ${CLI_PATH}; do not revert or rewrite files outside that scope.

Spec:
{{steps.read-spec.output}}

Current CLI:
{{steps.read-cli.output}}

Current Phase 1-3 API surface:
{{steps.read-phase-api-surface.output}}

Requirements:
1. Update printUsage() in ${CLI_PATH} to match the "Updated printUsage() Content" section of the spec.
2. Preserve existing YAML mode, resume mode, validation mode, agent mode parsing, exports, imports, and runtime behavior.
3. Keep flag names, short aliases, defaults, and examples aligned with parseAgentFlags().
4. Include YAML Mode Options, Agent Mode Options, General, and all examples from the spec.
5. Do not add dependencies and do not edit any file except ${CLI_PATH}.

Only edit ${CLI_PATH}. End your output with CLI_HELP_DOCS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'CLI_HELP_DOCS_DONE' },
    retries: 2,
  });

  wf.step('verify-cli-help-text', {
    type: 'deterministic',
    dependsOn: ['update-cli-help-text'],
    command: [
      `grep -q -- "<task>.*--agent <persona>" ${CLI_PATH}`,
      `grep -q -- "Run a relay.yaml workflow file, or generate and run a workflow from a persona." ${CLI_PATH}`,
      `grep -q -- "YAML Mode Options:" ${CLI_PATH}`,
      `grep -q -- "Agent Mode Options:" ${CLI_PATH}`,
      `grep -q -- "--agent, -a <ref>" ${CLI_PATH}`,
      `grep -q -- "--profile, -p <id>" ${CLI_PATH}`,
      `grep -q -- "--tier, -t <tier>" ${CLI_PATH}`,
      `grep -q -- "--dry-run, -d" ${CLI_PATH}`,
      `grep -q -- "--context, -c <path>" ${CLI_PATH}`,
      `grep -q -- "--verify, -v <cmd>" ${CLI_PATH}`,
      `grep -q -- "--output, -o <path>" ${CLI_PATH}`,
      `grep -q -- "--concurrency <n>" ${CLI_PATH}`,
      `grep -q -- "--timeout <ms>" ${CLI_PATH}`,
      `grep -q -- "Review auth for vulnerabilities" ${CLI_PATH}`,
      `grep -q -- "Refactor auth module" ${CLI_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('update-readme-agent-mode', {
    agent: 'readme-doc-writer',
    dependsOn: ['read-spec', 'read-readme', 'read-cli'],
    task: `
You are implementing the Phase 5 README documentation. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Own only ${README_PATH}; do not revert or rewrite files outside that scope.

Spec:
{{steps.read-spec.output}}

Current README:
{{steps.read-readme.output}}

Current CLI help context:
{{steps.read-cli.output}}

Requirements:
1. Add a new "## Agent Mode" section after the existing Quick Start or Usage section.
2. Include the Basic Usage, With Explicit Context Files, and Dry Run examples from the spec.
3. Include the All Agent Mode Flags table with every flag, alias, type, default, and description from the spec.
4. Include the Available Personas table with all 13 production intents and the correct preset/pattern values.
5. Keep this README section concise; leave the comprehensive guide details for ${AGENT_FLAG_DOC_PATH}.
6. Preserve all unrelated README content and formatting.
7. Do not edit any file except ${README_PATH}.

Only edit ${README_PATH}. End your output with README_AGENT_MODE_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'README_AGENT_MODE_DONE' },
    retries: 2,
  });

  wf.step('verify-readme-agent-mode', {
    type: 'deterministic',
    dependsOn: ['update-readme-agent-mode'],
    command: [
      `grep -q -- "^## Agent Mode" ${README_PATH}`,
      `grep -q -- "persona-driven workflow generation" ${README_PATH}`,
      `grep -q -- "agent-relay run \\"Review the auth module for security vulnerabilities\\" --agent security-review" ${README_PATH}`,
      `grep -q -- "agent-relay run \\"Refactor the payment service\\" --agent code-gen" ${README_PATH}`,
      `grep -q -- "agent-relay run \\"Write API documentation\\" --agent documentation --dry-run" ${README_PATH}`,
      `grep -q -- "--agent <ref>" ${README_PATH}`,
      `grep -q -- "--profile <id>" ${README_PATH}`,
      `grep -q -- "--tier <tier>" ${README_PATH}`,
      `grep -q -- "--dry-run" ${README_PATH}`,
      `grep -q -- "--context <path>" ${README_PATH}`,
      `grep -q -- "--verify <cmd>" ${README_PATH}`,
      `grep -q -- "--output <path>" ${README_PATH}`,
      `grep -q -- "--concurrency <n>" ${README_PATH}`,
      `grep -q -- "--timeout <ms>" ${README_PATH}`,
      `grep -q -- "security-review" ${README_PATH}`,
      `grep -q -- "requirements-analysis" ${README_PATH}`,
      `grep -q -- "implement-frontend" ${README_PATH}`,
      `grep -q -- "npm-provenance" ${README_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('write-agent-flag-guides', {
    agent: 'agent-guide-writer',
    dependsOn: ['read-spec', 'read-existing-docs', 'read-doc-style', 'read-phase-api-surface'],
    task: `
You are implementing the dedicated Phase 5 agent-mode documentation guide. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Own only ${AGENT_FLAG_DOC_PATH} and ${AGENT_FLAG_MDX_PATH}; do not revert or rewrite files outside that scope.

Spec:
{{steps.read-spec.output}}

Existing docs, if present:
{{steps.read-existing-docs.output}}

Docs style references:
{{steps.read-doc-style.output}}

Current Phase 1-3 API surface:
{{steps.read-phase-api-surface.output}}

Requirements:
1. Create or update ${AGENT_FLAG_DOC_PATH} with the complete "Agent Mode (--agent Flag)" guide from the spec.
2. Include How It Works, all 8 usage examples, Persona Reference, Custom Personas, Context Heuristics, and Troubleshooting.
3. Include runnable bash examples and valid TypeScript examples using @agent-relay/sdk/workflows.
4. Create or update ${AGENT_FLAG_MDX_PATH} as the MDX mirror with the required frontmatter.
5. Follow the docs-sync rule: the MDX content must mirror the markdown content, converting plain note/warning blocks to <Note> and <Warning> where appropriate.
6. Use <CodeGroup> only when it helps group adjacent examples; keep MDX valid.
7. Do not add dependencies and do not edit any files except ${AGENT_FLAG_DOC_PATH} and ${AGENT_FLAG_MDX_PATH}.

Only edit ${AGENT_FLAG_DOC_PATH} and ${AGENT_FLAG_MDX_PATH}. End your output with AGENT_FLAG_GUIDES_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'AGENT_FLAG_GUIDES_DONE' },
    retries: 2,
  });

  wf.step('verify-agent-flag-guides', {
    type: 'deterministic',
    dependsOn: ['write-agent-flag-guides'],
    command: [
      `test -f ${AGENT_FLAG_DOC_PATH}`,
      `test -f ${AGENT_FLAG_MDX_PATH}`,
      `grep -q -- "^# Agent Mode" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "Agent Mode (--agent Flag)" ${AGENT_FLAG_MDX_PATH}`,
      `grep -q -- "Generate and execute workflows from persona-driven task descriptions using the --agent CLI flag." ${AGENT_FLAG_MDX_PATH}`,
      `grep -q -- "## How It Works" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "### 1. Basic" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "### 8. Custom Concurrency and Timeout" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "## Persona Reference" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "## Context Heuristics" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "## Troubleshooting" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "resolvePersonaByIdOrIntent" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "generateWorkflow" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "reviewer-v2" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "npm-provenance" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "<Note" ${AGENT_FLAG_MDX_PATH}`,
      `grep -q -- "<Warning" ${AGENT_FLAG_MDX_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('write-sdk-reference-docs', {
    agent: 'sdk-reference-writer',
    dependsOn: ['read-spec', 'read-existing-docs', 'read-doc-style', 'read-phase-api-surface'],
    task: `
You are implementing Phase 5 SDK API reference documentation. Do not use Relaycast MCP tools or spawn sub-agents.

You are not alone in the codebase. Own only ${SDK_REFERENCE_DOC_PATH} and ${SDK_REFERENCE_MDX_PATH}; do not revert or rewrite files outside that scope.

Spec:
{{steps.read-spec.output}}

Existing docs, if present:
{{steps.read-existing-docs.output}}

Docs style references:
{{steps.read-doc-style.output}}

Current Phase 1-3 API surface:
{{steps.read-phase-api-surface.output}}

Requirements:
1. Create ${SDK_REFERENCE_DOC_PATH} if it does not exist, or append the Phase 5 sections if it does.
2. Add the Persona Resolution API section exactly covering resolvePersonaByIdOrIntent(), derivePreset(), derivePattern(), personaRegistry, constants, and types.
3. Add the Workflow Generator API section covering generateWorkflow(), WorkflowGeneratorOptions, and WorkflowMetadata.
4. Add the SDK Exports Summary tables for persona-utils.ts, workflow-generator.ts, context-heuristics.ts, and cli.ts.
5. Create ${SDK_REFERENCE_MDX_PATH} as the MDX mirror with appropriate frontmatter and mirrored content.
6. Keep code examples valid TypeScript with imports from @agent-relay/sdk/workflows.
7. Follow the docs-sync rule between the markdown and MDX files.
8. Do not add dependencies and do not edit any files except ${SDK_REFERENCE_DOC_PATH} and ${SDK_REFERENCE_MDX_PATH}.

Only edit ${SDK_REFERENCE_DOC_PATH} and ${SDK_REFERENCE_MDX_PATH}. End your output with SDK_REFERENCE_DOCS_DONE.
`.trim(),
    verification: { type: 'output_contains', value: 'SDK_REFERENCE_DOCS_DONE' },
    retries: 2,
  });

  wf.step('verify-sdk-reference-docs', {
    type: 'deterministic',
    dependsOn: ['write-sdk-reference-docs'],
    command: [
      `test -f ${SDK_REFERENCE_DOC_PATH}`,
      `test -f ${SDK_REFERENCE_MDX_PATH}`,
      `grep -q -- "## Persona Resolution API" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "resolvePersonaByIdOrIntent" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "derivePreset" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "derivePattern" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "personaRegistry" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "ANALYST_INTENTS" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "PIPELINE_INTENTS" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "## Workflow Generator API" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "generateWorkflow" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "WorkflowGeneratorOptions" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "WorkflowMetadata" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "inferContextFiles" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "parseAgentFlags" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "AgentModeFlags" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "title:" ${SDK_REFERENCE_MDX_PATH}`,
      `grep -q -- "Persona Resolution API" ${SDK_REFERENCE_MDX_PATH}`,
      `grep -q -- "Workflow Generator API" ${SDK_REFERENCE_MDX_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('verify-docs-sync-and-format', {
    type: 'deterministic',
    dependsOn: [
      'verify-cli-help-text',
      'verify-readme-agent-mode',
      'verify-agent-flag-guides',
      'verify-sdk-reference-docs',
    ],
    command: [
      `for flag in --agent --profile --tier --dry-run --context --verify --output --concurrency --timeout; do grep -q -- "$flag" ${CLI_PATH} || exit 1; grep -q -- "$flag" ${README_PATH} || exit 1; grep -q -- "$flag" ${AGENT_FLAG_DOC_PATH} || exit 1; done`,
      `for intent in review security-review architecture-plan requirements-analysis verification test-strategy documentation tdd-enforcement debugging code-gen implement-frontend flake-investigation npm-provenance; do grep -q -- "$intent" ${README_PATH} || exit 1; grep -q -- "$intent" ${AGENT_FLAG_DOC_PATH} || exit 1; done`,
      `grep -q -- "Agent Mode" ${AGENT_FLAG_DOC_PATH}`,
      `grep -q -- "Agent Mode" ${AGENT_FLAG_MDX_PATH}`,
      `grep -q -- "Persona Resolution API" ${SDK_REFERENCE_DOC_PATH}`,
      `grep -q -- "Persona Resolution API" ${SDK_REFERENCE_MDX_PATH}`,
      `perl -0ne '$n=()=/\\x60\\x60\\x60/g; exit($n%2)' ${README_PATH}`,
      `perl -0ne '$n=()=/\\x60\\x60\\x60/g; exit($n%2)' ${AGENT_FLAG_DOC_PATH}`,
      `perl -0ne '$n=()=/\\x60\\x60\\x60/g; exit($n%2)' ${AGENT_FLAG_MDX_PATH}`,
      `perl -0ne '$n=()=/\\x60\\x60\\x60/g; exit($n%2)' ${SDK_REFERENCE_DOC_PATH}`,
      `perl -0ne '$n=()=/\\x60\\x60\\x60/g; exit($n%2)' ${SDK_REFERENCE_MDX_PATH}`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('review-phase-5-docs', {
    agent: 'docs-reviewer',
    dependsOn: ['read-spec', 'verify-docs-sync-and-format'],
    task: `
Review the Phase 5 documentation implementation. Do not edit files. Do not use Relaycast MCP tools or spawn sub-agents.

Spec:
{{steps.read-spec.output}}

Deterministic verification output:
{{steps.verify-docs-sync-and-format.output}}

Review these files:
- ${README_PATH}
- ${CLI_PATH}
- ${AGENT_FLAG_DOC_PATH}
- ${AGENT_FLAG_MDX_PATH}
- ${SDK_REFERENCE_DOC_PATH}
- ${SDK_REFERENCE_MDX_PATH}

Check:
1. README includes the Agent Mode section, three canonical examples, complete flag table, and all 13 production intents.
2. printUsage() covers YAML mode, agent mode, general help, all flags, aliases, defaults, and runnable examples.
3. ${AGENT_FLAG_DOC_PATH} has the comprehensive guide with 8+ examples, persona reference, context heuristics, custom personas, and troubleshooting.
4. ${AGENT_FLAG_MDX_PATH} mirrors the markdown guide with valid MDX frontmatter and component conversions.
5. ${SDK_REFERENCE_DOC_PATH} documents persona-utils, workflow-generator, context-heuristics, and cli public exports with valid TypeScript examples.
6. ${SDK_REFERENCE_MDX_PATH} mirrors the SDK reference markdown with valid MDX frontmatter.
7. The docs-sync rule is satisfied and markdown code fences/tables render correctly.
8. No new dependencies or unrelated source changes were introduced.

Output REVIEW_PASS if acceptable; otherwise output REVIEW_FAIL with concrete blockers.
`.trim(),
    verification: { type: 'output_contains', value: 'REVIEW_PASS' },
    retries: 1,
  });

  wf.step('summarize-artifacts', {
    type: 'deterministic',
    dependsOn: ['review-phase-5-docs'],
    command: [
      `echo "Phase 5 documentation workflow completed."`,
      `echo "Artifacts:"`,
      `echo "- ${README_PATH}"`,
      `echo "- ${CLI_PATH}"`,
      `echo "- ${AGENT_FLAG_DOC_PATH}"`,
      `echo "- ${AGENT_FLAG_MDX_PATH}"`,
      `echo "- ${SDK_REFERENCE_DOC_PATH}"`,
      `echo "- ${SDK_REFERENCE_MDX_PATH}"`,
      `git diff -- ${README_PATH} ${CLI_PATH} ${AGENT_FLAG_DOC_PATH} ${AGENT_FLAG_MDX_PATH} ${SDK_REFERENCE_DOC_PATH} ${SDK_REFERENCE_MDX_PATH} | sed -n '1,520p'`,
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
