/**
 * Meta Workflow Coordinator
 *
 * This workflow coordinates the creation of all Phase 1-5 meta workflows
 * for the --agent flag feature by spawning Claude and Codex sub-agents.
 */

import { workflow } from '@agent-relay/sdk/workflows';

const WORKFLOWS_DIR = 'workflows/meta-agent-flag';

async function main() {
  const result = await workflow('meta-workflow-coordinator')
    .description('Coordinate creation of --agent flag meta workflows')
    .pattern('pipeline')
    .channel('wf-meta-workflow-coordinator')
    .maxConcurrency(1)
    .timeout(3_600_000)

    .agent('claude-designer', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes specification documents for workflow implementation phases',
      retries: 1,
    })

    .agent('codex-implementer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Implements TypeScript workflow files from specifications',
      retries: 2,
    })

    // Phase 1: Design Phase 1 spec
    .step('design-phase-1', {
      agent: 'claude-designer',
      task: `Write a specification document for Phase 1 of the --agent flag feature.

Read the design plan at: /Users/khaliqgant/Projects/AgentWorkforce/workforce/workflows/investigation/design-plan.md

Write the spec to: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/01-sdk-persona-resolution.spec.md

The spec should include:
- Goal: Add resolvePersonaByIdOrIntent(), derivePreset(), derivePattern() to SDK
- Files to create: packages/sdk/src/workflows/persona-utils.ts, packages/sdk/src/workflows/__tests__/persona-utils.test.ts
- Key implementation details from the design plan
- TypeScript interfaces for WorkflowGeneratorInput, PersonaSelection
- Dependencies: none (Phase 1)

Format as markdown with code examples.`,
      verification: { type: 'exit_code' },
      retries: 1,
    })

    // Phase 2: Design Phase 2 spec
    .step('design-phase-2', {
      agent: 'claude-designer',
      dependsOn: ['design-phase-1'],
      task: `Write a specification document for Phase 2 of the --agent flag feature.

Read the design plan at: /Users/khaliqgant/Projects/AgentWorkforce/workforce/workflows/investigation/design-plan.md

Write the spec to: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/02-workflow-generator.spec.md

The spec should include:
- Goal: Create workflow generator module in packages/sdk/src/
- Files to create: packages/sdk/src/workflow-generator.ts, __tests__/workflow-generator.test.ts
- Key functions: generateWorkflow(), emitBootstrapPhase(), emitSkillPhase(), emitContextPhase(), emitTaskPhase(), emitVerificationPhase(), emitFinalPhase()
- WorkflowGeneratorInput interface
- Dependencies: Phase 1 (persona-utils)

Format as markdown with code examples.`,
      verification: { type: 'exit_code' },
      retries: 1,
    })

    // Phase 3: Design Phase 3 spec
    .step('design-phase-3', {
      agent: 'claude-designer',
      dependsOn: ['design-phase-2'],
      task: `Write a specification document for Phase 3 of the --agent flag feature.

Read the design plan at: /Users/khaliqgant/Projects/AgentWorkforce/workforce/workflows/investigation/design-plan.md

Write the spec to: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/03-cli-agent-flag.spec.md

The spec should include:
- Goal: Wire --agent flag into CLI
- Files to modify: packages/sdk/src/workflows/cli.ts
- CLI flag parsing for --agent, --profile, --tier, --dry-run, --context, --verify, --output, --concurrency, --timeout
- Default context file heuristics per intent
- ResolvePersonaByIdOrIntent integration
- Dependencies: Phase 2 (workflow-generator)

Format as markdown with code examples.`,
      verification: { type: 'exit_code' },
      retries: 1,
    })

    // Phase 4: Design Phase 4 spec
    .step('design-phase-4', {
      agent: 'claude-designer',
      dependsOn: ['design-phase-3'],
      task: `Write a specification document for Phase 4 of the --agent flag feature.

Read the design plan at: /Users/khaliqgant/Projects/AgentWorkforce/workforce/workflows/investigation/design-plan.md

Write the spec to: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/04-tests.spec.md

The spec should include:
- Goal: Unit and integration tests for all new SDK functions
- Files to create: packages/sdk/src/workflows/__tests__/persona-utils.test.ts, workflow-generator.test.ts, workflow-generator.integration.test.ts
- Test cases for resolvePersonaByIdOrIntent with all 13 persona IDs and intents
- Test cases for derivePreset and derivePattern
- Snapshot tests comparing generated workflows against reference workflows
- Dependencies: Phase 3 (CLI integration)

Format as markdown with code examples.`,
      verification: { type: 'exit_code' },
      retries: 1,
    })

    // Phase 5: Design Phase 5 spec
    .step('design-phase-5', {
      agent: 'claude-designer',
      dependsOn: ['design-phase-4'],
      task: `Write a specification document for Phase 5 of the --agent flag feature.

Read the design plan at: /Users/khaliqgant/Projects/AgentWorkforce/workforce/workflows/investigation/design-plan.md

Write the spec to: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/05-documentation.spec.md

The spec should include:
- Goal: Documentation for the --agent flag feature
- Files to modify: README.md, CLI help text in cli.ts
- Usage examples for:
  1. Basic: agent-relay run "task" --agent <persona>
  2. With context: agent-relay run "task" --agent <persona> --context file1 --context file2
  3. Dry run: agent-relay run "task" --agent <persona> --dry-run
- SDK exports documentation
- Dependencies: Phase 4 (tests)

Format as markdown with code examples.`,
      verification: { type: 'exit_code' },
      retries: 1,
    })

    // Now implement all meta workflows using codex
    .step('implement-phase-1', {
      agent: 'codex-implementer',
      dependsOn: ['design-phase-1'],
      task: `Implement the Phase 1 meta workflow from the spec.

Read the spec at: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/01-sdk-persona-resolution.spec.md

Create the file: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/01-sdk-persona-resolution.ts

This should be a complete agent-relay workflow file that:
1. Uses the workflow builder API: const { workflow } = require('@agent-relay/sdk/workflows')
2. Creates packages/sdk/src/workflows/persona-utils.ts with the SDK functions
3. Creates unit tests
4. Follows the existing SDK code patterns

Use .step() for deterministic steps and .agent() for agent steps.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('implement-phase-2', {
      agent: 'codex-implementer',
      dependsOn: ['design-phase-2', 'implement-phase-1'],
      task: `Implement the Phase 2 meta workflow from the spec.

Read the spec at: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/02-workflow-generator.spec.md

Create the file: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/02-workflow-generator.ts

This should be a complete agent-relay workflow file that creates:
1. packages/sdk/src/workflow-generator.ts - the main generator module
2. Template functions for each phase (bootstrap, skills, context, task, verification, final)

The generator should output complete workflow .ts files.`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('implement-phase-3', {
      agent: 'codex-implementer',
      dependsOn: ['design-phase-3', 'implement-phase-2'],
      task: `Implement the Phase 3 meta workflow from the spec.

Read the spec at: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/03-cli-agent-flag.spec.md

Create the file: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/03-cli-agent-flag.ts

This should be a complete agent-relay workflow file that:
1. Modifies packages/sdk/src/workflows/cli.ts to add --agent flag parsing
2. Adds resolvePersonaByIdOrIntent integration
3. Adds default context heuristics
4. Handles --dry-run mode`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('implement-phase-4', {
      agent: 'codex-implementer',
      dependsOn: ['design-phase-4', 'implement-phase-3'],
      task: `Implement the Phase 4 meta workflow from the spec.

Read the spec at: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/04-tests.spec.md

Create the file: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/04-tests.ts

This should be a complete agent-relay workflow file that:
1. Creates unit tests for persona-utils
2. Creates unit tests for workflow-generator
3. Creates integration tests`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .step('implement-phase-5', {
      agent: 'codex-implementer',
      dependsOn: ['design-phase-5', 'implement-phase-4'],
      task: `Implement the Phase 5 meta workflow from the spec.

Read the spec at: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/05-documentation.spec.md

Create the file: /Users/khaliqgant/Projects/AgentWorkforce/relay-workflows/${WORKFLOWS_DIR}/05-documentation.ts

This should be a complete agent-relay workflow file that:
1. Updates README.md with --agent flag documentation
2. Adds usage examples
3. Updates CLI help text`,
      verification: { type: 'exit_code' },
      retries: 2,
    })

    .onError('fail-fast')
    .run({ cwd: '/Users/khaliqgant/Projects/AgentWorkforce/relay-workflows' });

  console.log('Result:', result.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
