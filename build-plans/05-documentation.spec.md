# Phase 5 Specification: Documentation for the `--agent` Flag Feature

> Document the `--agent` flag feature across README, CLI help text, and SDK API reference so that users and consumers can discover and use persona-driven workflow generation.

**Phase:** 5 of 5
**Dependencies:** Phase 4 (tests — all SDK functions must be tested and stable before documenting)
**Target files:**

- `README.md` (modify — add `--agent` flag section)
- `packages/sdk/src/workflows/cli.ts` (modify — update `printUsage()` help text)
- `docs/reference-sdk.md` (modify — add persona-utils and workflow-generator API docs)
- `web/content/docs/reference-sdk.mdx` (modify — MDX mirror of SDK API docs)
- `docs/agent-flag.md` (new — dedicated guide for the `--agent` flag)
- `web/content/docs/agent-flag.mdx` (new — MDX mirror of the agent flag guide)

---

## Goal

Provide complete, discoverable documentation for the `--agent` flag feature introduced in Phases 1–4. Documentation must cover three audiences:

1. **CLI users** — how to use `--agent` from the command line with zero prior setup
2. **SDK consumers** — how to import and use persona resolution and workflow generation programmatically
3. **Contributors** — how the persona registry, derivation rules, and workflow generator internals work

All documentation follows the docs-sync rule: `.mdx` files in `web/content/docs/` are mirrored as `.md` files in `docs/` with MDX components converted to plain markdown.

---

## File 1: `README.md` — Add `--agent` Flag Section

### Location

Add a new section after the existing "Quick Start" or "Usage" section. The section should be titled **"Agent Mode"** and provide a concise overview with three key examples.

### Content to Add

````markdown
## Agent Mode

The `--agent` flag enables persona-driven workflow generation. Instead of writing a YAML workflow file, describe your task in plain text and specify an agent persona — the CLI resolves the persona, generates a typed workflow, and executes it in one command.

### Basic Usage

```bash
agent-relay run "Review the auth module for security vulnerabilities" --agent security-review
```
````

This resolves the `security-review` persona, generates a DAG workflow with context-gathering and verification steps, and executes it immediately.

### With Explicit Context Files

```bash
agent-relay run "Refactor the payment service" --agent code-gen \
  --context src/services/payment.ts \
  --context src/services/payment.test.ts
```

Use `--context` (repeatable) to specify which files the agent should read. When omitted, the CLI infers context files based on the persona's intent.

### Dry Run

```bash
agent-relay run "Write API documentation" --agent documentation --dry-run
```

The `--dry-run` flag prints the generated workflow source and metadata without executing. Use this to inspect what would run before committing to execution.

### All Agent Mode Flags

| Flag                | Short | Type       | Default     | Description                                                |
| ------------------- | ----- | ---------- | ----------- | ---------------------------------------------------------- |
| `--agent <ref>`     | `-a`  | `string`   | —           | Persona ID or intent string (required for agent mode)      |
| `--profile <id>`    | `-p`  | `string`   | —           | Disambiguation hint when multiple personas share an intent |
| `--tier <tier>`     | `-t`  | `string`   | `standard`  | Execution tier: `standard` or `premium`                    |
| `--dry-run`         | `-d`  | `boolean`  | `false`     | Print generated workflow without executing                 |
| `--context <path>`  | `-c`  | `string[]` | (heuristic) | Context file to read (repeatable)                          |
| `--verify <cmd>`    | `-v`  | `string[]` | `[]`        | Verification command, must exit 0 (repeatable)             |
| `--output <path>`   | `-o`  | `string`   | —           | Write generated workflow source to file                    |
| `--concurrency <n>` | —     | `number`   | `4`         | Max concurrent steps                                       |
| `--timeout <ms>`    | —     | `number`   | `3600000`   | Workflow timeout in milliseconds                           |

### Available Personas

| Intent                  | Preset  | Pattern  | Description                         |
| ----------------------- | ------- | -------- | ----------------------------------- |
| `review`                | analyst | dag      | Code review and quality analysis    |
| `security-review`       | analyst | dag      | Security vulnerability analysis     |
| `architecture-plan`     | analyst | dag      | Architecture planning and design    |
| `requirements-analysis` | analyst | pipeline | Requirements gathering and analysis |
| `verification`          | analyst | dag      | Evidence-based verification         |
| `test-strategy`         | analyst | dag      | Test strategy planning              |
| `documentation`         | worker  | pipeline | Documentation generation            |
| `tdd-enforcement`       | worker  | pipeline | TDD coaching and enforcement        |
| `debugging`             | worker  | dag      | Bug investigation and fixing        |
| `code-gen`              | worker  | dag      | General code generation             |
| `implement-frontend`    | worker  | dag      | Frontend implementation             |
| `flake-investigation`   | worker  | dag      | Flaky test investigation            |
| `npm-provenance`        | worker  | dag      | NPM provenance configuration        |

````

---

## File 2: `packages/sdk/src/workflows/cli.ts` — Update `printUsage()`

### Current State

The `printUsage()` function in `cli.ts` needs to reflect the agent mode flags as specified in Phase 3. This may have been partially implemented during Phase 3; this phase ensures the help text is complete, accurate, and matches the final API.

### Updated `printUsage()` Content

```ts
function printUsage(): void {
  console.log(
    `
Usage: relay-workflow <yaml-path> [options]
       relay-workflow "<task>" --agent <persona> [agent-options]
       relay-workflow --resume <run-id>

Run a relay.yaml workflow file, or generate and run a workflow from a persona.

Arguments:
  <yaml-path>              Path to the relay.yaml workflow file
  <task>                   Task description (in agent mode)

YAML Mode Options:
  --workflow <name>        Run a specific workflow by name (default: first)
  --resume <run-id>        Resume a failed or interrupted run by its run ID
  --start-from <step>      Start from a specific step, skipping predecessors
  --previous-run-id <id>   Use cached outputs from a specific prior run
  --validate               Validate workflow YAML without running

Agent Mode Options:
  --agent, -a <ref>        Persona ID or intent (e.g., 'security-review', 'reviewer-v1')
  --profile, -p <id>       Disambiguation hint for shared intents
  --tier, -t <tier>        Execution tier: 'standard' (default) or 'premium'
  --dry-run, -d            Print generated workflow without executing
  --context, -c <path>     Context file to read (repeatable)
  --verify, -v <cmd>       Verification command (repeatable, must exit 0)
  --output, -o <path>      Write generated workflow source to file
  --concurrency <n>        Max concurrent steps (default: 4)
  --timeout <ms>           Workflow timeout in ms (default: 3600000)

General:
  --help                   Show this help message

Examples:
  # YAML mode
  relay-workflow workflows/daytona-migration.yaml
  relay-workflow workflows/feature-dev.yaml --workflow build-and-test

  # Agent mode — basic
  relay-workflow "Review auth for vulnerabilities" --agent security-review

  # Agent mode — with context files
  relay-workflow "Fix flaky test in CI" --agent debugging --context tests/flaky.test.ts

  # Agent mode — dry run
  relay-workflow "Write API docs" --agent documentation --dry-run

  # Agent mode — with output and verification
  relay-workflow "Refactor auth module" -a code-gen -c src/auth.ts -o workflow.ts -v "npm test"
`.trim()
  );
}
````

### Validation

- Help text must display when `--help` is passed or when no arguments are provided
- All flag names, short aliases, and defaults must match the `parseAgentFlags()` implementation from Phase 3
- Examples must be runnable commands (valid flag combinations)

---

## File 3: `docs/agent-flag.md` — Dedicated Agent Flag Guide

### Purpose

A standalone guide for the `--agent` flag feature, providing comprehensive usage documentation with examples, persona reference, and troubleshooting.

### Content Structure

````markdown
# Agent Mode (`--agent` Flag)

The `--agent` flag transforms `relay-workflow` from a YAML executor into a persona-driven workflow generator. Describe your task, pick a persona, and the CLI handles the rest.

## How It Works

1. **Parse** — the CLI extracts the task description and `--agent` reference
2. **Resolve** — the persona is resolved via `resolvePersonaByIdOrIntent()`, mapping the reference to an intent, preset (`worker` or `analyst`), and swarm pattern (`dag` or `pipeline`)
3. **Infer** — if no `--context` files are provided, the CLI infers context files from intent heuristics
4. **Generate** — `generateWorkflow()` produces a complete TypeScript workflow using the `WorkflowBuilder` API
5. **Execute** — the generated workflow runs immediately (unless `--dry-run` is set)

## Usage Examples

### 1. Basic — Single Persona

```bash
agent-relay run "Review the auth module for security vulnerabilities" --agent security-review
```
````

Resolves `security-review` to:

- **Preset:** `analyst` (read-only analysis, no code modification)
- **Pattern:** `dag` (parallel context reads, convergent analysis)
- **Agent:** `security-reviewer-v1` from the default persona registry

### 2. With Explicit Context Files

```bash
agent-relay run "Refactor the payment service" --agent code-gen \
  --context src/services/payment.ts \
  --context src/services/payment.test.ts \
  --context src/types/payment.d.ts
```

The `--context` flag is repeatable. Each path becomes a deterministic step that captures the file content for the agent's task prompt via `{{steps.X.output}}` interpolation.

When `--context` is provided, intent-based heuristics are skipped entirely.

### 3. Dry Run — Inspect Before Executing

```bash
agent-relay run "Write API documentation for the SDK" --agent documentation --dry-run
```

Output includes:

- Generated TypeScript workflow source
- Workflow metadata (step count, estimated waves, pattern, preset)
- Resolved persona details
- Inferred context files (if any)

### 4. With Verification Commands

```bash
agent-relay run "Fix the broken login flow" --agent debugging \
  --context src/auth/login.ts \
  --verify "npm test -- --grep 'login'" \
  --verify "npx tsc --noEmit"
```

Verification commands run after the agent completes its task. Each must exit 0 for the workflow to succeed. Failed verifications cause the workflow to fail with a clear error.

### 5. Save Generated Workflow to Disk

```bash
agent-relay run "Implement pagination for the users API" --agent code-gen \
  --output workflows/generated/users-pagination.ts
```

The `--output` flag writes the generated TypeScript workflow to disk before executing. This is useful for:

- Reviewing and customizing the generated workflow
- Re-running the same workflow later without regeneration
- Version-controlling generated workflows

### 6. Profile Disambiguation

```bash
agent-relay run "Review the database migration" --agent review --profile reviewer-v2
```

When multiple personas share the same intent (e.g., `reviewer-v1` and `reviewer-v2` both serve `review`), use `--profile` to select a specific persona by ID.

### 7. Premium Tier Execution

```bash
agent-relay run "Architect a new microservice" --agent architecture-plan --tier premium
```

The `--tier` flag controls model selection. `premium` uses higher-capability models at increased cost.

### 8. Custom Concurrency and Timeout

```bash
agent-relay run "Run security audit" --agent security-review \
  --concurrency 8 \
  --timeout 7200000
```

- `--concurrency` controls the max number of parallel steps (1–32, default: 4)
- `--timeout` sets the workflow timeout in milliseconds (minimum: 1000, default: 3600000 = 1 hour)

## Persona Reference

### Preset Types

| Preset    | Behavior                                                 | Use When                                                 |
| --------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `worker`  | Can modify files, create code, write documentation       | The task produces artifacts or changes code              |
| `analyst` | Read-only analysis, produces reports and recommendations | The task is investigation or review with no code changes |

### Pattern Types

| Pattern    | Behavior                                      | Use When                                                           |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `dag`      | Parallel context reads + convergent execution | Context steps are independent and can run simultaneously           |
| `pipeline` | Sequential step-by-step processing            | Task has inherent ordering (e.g., analyze → synthesize → validate) |

### Default Persona Registry

| ID                        | Name                    | Intent                  | Preset  | Pattern  |
| ------------------------- | ----------------------- | ----------------------- | ------- | -------- |
| `reviewer-v1`             | Code Reviewer           | `review`                | analyst | dag      |
| `reviewer-v2`             | Senior Reviewer         | `review`                | analyst | dag      |
| `architect-v1`            | Architecture Planner    | `architecture-plan`     | analyst | dag      |
| `requirements-analyst-v1` | Requirements Analyst    | `requirements-analysis` | analyst | pipeline |
| `security-reviewer-v1`    | Security Reviewer       | `security-review`       | analyst | dag      |
| `verifier-v1`             | Verification Specialist | `verification`          | analyst | dag      |
| `test-strategist-v1`      | Test Strategist         | `test-strategy`         | analyst | dag      |
| `docs-writer-v1`          | Documentation Writer    | `documentation`         | worker  | pipeline |
| `tdd-coach-v1`            | TDD Coach               | `tdd-enforcement`       | worker  | pipeline |
| `code-worker-v1`          | Code Worker             | `code-gen`              | worker  | dag      |

### Custom Personas

The persona registry is extensible. To add custom personas programmatically:

```ts
import { personaRegistry } from '@agent-relay/sdk/workflows';

personaRegistry.register({
  id: 'my-custom-reviewer-v1',
  name: 'Custom Reviewer',
  intent: 'review',
  preset: 'analyst',
  pattern: 'dag',
  description: 'Reviews code with custom org standards',
});
```

## Context Heuristics

When `--context` is omitted, the CLI infers context files based on the resolved intent:

| Intent              | Auto-detected Context                         |
| ------------------- | --------------------------------------------- |
| `review`            | Changed files (`git diff`), `tsconfig.json`   |
| `security-review`   | Changed files, `package.json`, `.env.example` |
| `architecture-plan` | `tsconfig.json`, `package.json`, entry points |
| `debugging`         | Test output (`npm test`), failing test files  |
| `documentation`     | `README.md`, entry points, existing docs      |
| `verification`      | CI workflows, `package.json`, `tsconfig.json` |
| `npm-provenance`    | Publish workflow, `package.json`, `.npmrc`    |

Context files are capped at 10 per workflow to avoid overwhelming the agent.

## Troubleshooting

### "Unknown persona" warning

If `--agent` receives a ref that doesn't match any registered persona ID or intent, the CLI falls back to derivation:

- Unknown refs default to `preset: 'worker'` and `pattern: 'dag'`
- The workflow still generates and runs — just without persona-specific configuration
- Use `--dry-run` to verify resolution before executing

### No context files inferred

If intent heuristics find no matching files on disk, the workflow runs with an empty context phase. Use `--context` to explicitly provide files.

### Mutual exclusivity

Agent mode flags (`--agent`, `--context`, `--verify`, `--dry-run`, `--profile`, `--tier`, `--output`) are mutually exclusive with YAML mode flags (`--resume`, `--workflow`, `--start-from`, `--previous-run-id`, `--validate`). Mixing them produces an error.

````

---

## File 4: `web/content/docs/agent-flag.mdx` — MDX Mirror

The MDX version includes the same content as `docs/agent-flag.md` with:
- YAML frontmatter (`title`, `description`)
- `<CodeGroup>` wrapping for multi-example code blocks
- `<Note>` and `<Warning>` components where appropriate

### Frontmatter

```yaml
---
title: "Agent Mode (--agent Flag)"
description: "Generate and execute workflows from persona-driven task descriptions using the --agent CLI flag."
---
````

### MDX-specific conversions

| Plain markdown (`.md`) | MDX (`.mdx`)             |
| ---------------------- | ------------------------ |
| `> **Note:**`          | `<Note>`                 |
| `> **Warning:**`       | `<Warning>`              |
| Adjacent code blocks   | Wrap in `<CodeGroup>`    |
| No frontmatter         | Include YAML frontmatter |

---

## File 5: `docs/reference-sdk.md` — SDK API Reference Updates

### Location

Add a new section to the existing SDK reference for the persona-utils and workflow-generator exports.

### Content to Add

````markdown
## Persona Resolution API

### `resolvePersonaByIdOrIntent(ref, profile?)`

Resolves a persona reference (ID or intent string) to a complete `PersonaResolution` containing the intent, preset, pattern, and optional persona profile.

```ts
import { resolvePersonaByIdOrIntent } from '@agent-relay/sdk/workflows';

// Resolve by intent
const result = resolvePersonaByIdOrIntent('security-review');
// → { resolved: true, intent: 'security-review', preset: 'analyst', pattern: 'dag', persona: {...} }

// Resolve by persona ID
const result = resolvePersonaByIdOrIntent('reviewer-v2');
// → { resolved: true, intent: 'review', preset: 'analyst', pattern: 'dag', persona: {...} }

// Unknown ref — falls back to derivation
const result = resolvePersonaByIdOrIntent('custom-task');
// → { resolved: false, intent: 'custom-task', preset: 'worker', pattern: 'dag' }
```
````

**Parameters:**

- `ref` (`string`) — Persona ID or intent string
- `profile` (`PersonaProfile`, optional) — Disambiguation hint when multiple personas share an intent

**Returns:** `PersonaResolution`

### `derivePreset(intent)`

Pure function that maps an intent string to an `AgentPreset` (`'worker'` or `'analyst'`).

```ts
import { derivePreset } from '@agent-relay/sdk/workflows';

derivePreset('review'); // → 'analyst'
derivePreset('security-review'); // → 'analyst'
derivePreset('code-gen'); // → 'worker'
derivePreset('documentation'); // → 'worker'
```

### `derivePattern(intent)`

Pure function that maps an intent string to a `SwarmPattern` (`'dag'` or `'pipeline'`).

```ts
import { derivePattern } from '@agent-relay/sdk/workflows';

derivePattern('review'); // → 'dag'
derivePattern('requirements-analysis'); // → 'pipeline'
derivePattern('documentation'); // → 'pipeline'
derivePattern('code-gen'); // → 'dag'
```

### `personaRegistry`

Module-level singleton for managing persona profiles. Initialized with 10 default profiles on import.

```ts
import { personaRegistry } from '@agent-relay/sdk/workflows';

// Lookup by ID
const persona = personaRegistry.getById('reviewer-v1');

// Lookup by intent
const ids = personaRegistry.getByIntent('review');
// → ['reviewer-v1', 'reviewer-v2']

// Register a custom persona
personaRegistry.register({
  id: 'my-persona',
  name: 'My Persona',
  intent: 'custom-task',
  preset: 'worker',
  pattern: 'dag',
});
```

### Constants

```ts
import { ANALYST_INTENTS, PIPELINE_INTENTS } from '@agent-relay/sdk/workflows';

// ANALYST_INTENTS: 'review' | 'architecture-plan' | 'requirements-analysis'
//                  | 'security-review' | 'verification' | 'test-strategy'

// PIPELINE_INTENTS: 'requirements-analysis' | 'documentation' | 'tdd-enforcement'
```

### Types

```ts
import type {
  PersonaProfile,
  PersonaSelection,
  PersonaResolution,
  PersonaRegistry,
  WorkflowGeneratorInput,
  ContextFileSpec,
  VerificationSpec,
  SkillMaterializationPlan,
} from '@agent-relay/sdk/workflows';
```

## Workflow Generator API

### `generateWorkflow(input, options?)`

Generates a complete, runnable TypeScript workflow file from a `WorkflowGeneratorInput`.

```ts
import { generateWorkflow } from '@agent-relay/sdk/workflows';
import type { WorkflowGeneratorInput } from '@agent-relay/sdk/workflows';

const input: WorkflowGeneratorInput = {
  taskDescription: 'Review auth middleware',
  workflowName: 'review-auth',
  persona: {
    id: 'security-reviewer-v1',
    name: 'Security Reviewer',
    intent: 'security-review',
    preset: 'analyst',
    pattern: 'dag',
  },
  selection: {
    intent: 'security-review',
    preset: 'analyst',
    pattern: 'dag',
    resolved: true,
    resolutionType: 'intent',
  },
  skillPlan: { installs: [] },
  contextFiles: [{ stepName: 'read-auth', command: 'cat src/auth.ts' }],
  verifications: [{ stepName: 'verify-types', command: 'npx tsc --noEmit' }],
  maxConcurrency: 4,
  timeout: 3_600_000,
};

const { source, metadata } = generateWorkflow(input);

// source: complete TypeScript workflow file as a string
// metadata: { name, pattern, preset, stepCount, agentCount, estimatedWaves, ... }
```

**Parameters:**

- `input` (`WorkflowGeneratorInput`) — Resolved persona, task, context files, and verifications
- `options` (`WorkflowGeneratorOptions`, optional) — Code generation options

**Returns:** `GeneratedWorkflow` — `{ source: string, metadata: WorkflowMetadata }`

### `WorkflowGeneratorOptions`

```ts
interface WorkflowGeneratorOptions {
  indent?: 'spaces' | 'tabs'; // default: 'spaces'
  indentSize?: number; // default: 2
  comments?: boolean; // default: true
  header?: boolean; // default: true
}
```

### `WorkflowMetadata`

```ts
interface WorkflowMetadata {
  name: string;
  pattern: SwarmPattern;
  preset: AgentPreset;
  agentCount: number;
  stepCount: number;
  phases: {
    bootstrap: number;
    skills: number;
    context: number;
    task: number;
    verification: number;
    final: number;
  };
  hasSkills: boolean;
  hasVerification: boolean;
  estimatedWaves: number;
}
```

```

---

## File 6: `web/content/docs/reference-sdk.mdx` — MDX Mirror of SDK Reference

Apply the same additions as `docs/reference-sdk.md` with MDX components. Follow the docs-sync rule for component conversion.

---

## SDK Exports Summary

The following public exports were introduced across Phases 1–3 and must be documented:

### From `persona-utils.ts` (Phase 1)

| Export | Kind | Description |
|---|---|---|
| `resolvePersonaByIdOrIntent` | function | Resolve a persona ref to intent/preset/pattern |
| `resolvePersonaSelection` | function | Convenience wrapper accepting `PersonaSelection` |
| `derivePreset` | function | Map intent → `AgentPreset` |
| `derivePattern` | function | Map intent → `SwarmPattern` |
| `isAnalystIntent` | function | Check if intent maps to analyst preset |
| `isPipelineIntent` | function | Check if intent maps to pipeline pattern |
| `personaRegistry` | object | Singleton persona registry |
| `initPersonaRegistry` | function | Initialize registry with profiles |
| `resetPersonaRegistry` | function | Clear registry (testing) |
| `getPersonaIdToIntentMap` | function | Get reverse lookup map |
| `DEFAULT_PERSONA_PROFILES` | constant | Array of 10 default profiles |
| `ANALYST_INTENTS` | constant | Tuple of analyst intent strings |
| `PIPELINE_INTENTS` | constant | Tuple of pipeline intent strings |
| `PersonaProfile` | type | Persona profile shape |
| `PersonaSelection` | type | Input for persona resolution |
| `PersonaResolution` | type | Result of persona resolution |
| `PersonaRegistry` | type | Registry interface |
| `WorkflowGeneratorInput` | type | Input for workflow generation |
| `ContextFileSpec` | type | Context file step spec |
| `VerificationSpec` | type | Verification step spec |
| `SkillMaterializationPlan` | type | Skill install plan |
| `AnalystIntent` | type | Union of analyst intent strings |
| `PipelineIntent` | type | Union of pipeline intent strings |

### From `workflow-generator.ts` (Phase 2)

| Export | Kind | Description |
|---|---|---|
| `generateWorkflow` | function | Generate workflow source from input |
| `emitBootstrapPhase` | function | Generate bootstrap phase lines |
| `emitSkillPhase` | function | Generate skill install phase lines |
| `emitContextPhase` | function | Generate context-gathering phase lines |
| `emitTaskPhase` | function | Generate task execution phase lines |
| `emitVerificationPhase` | function | Generate verification phase lines |
| `emitFinalPhase` | function | Generate final phase lines |
| `GeneratedWorkflow` | type | Output of `generateWorkflow` |
| `WorkflowMetadata` | type | Metadata about generated workflow |
| `WorkflowGeneratorOptions` | type | Code generation options |

### From `context-heuristics.ts` (Phase 3)

| Export | Kind | Description |
|---|---|---|
| `inferContextFiles` | function | Infer context files from intent + filesystem |
| `ContextHeuristic` | type | Heuristic definition shape |
| `CandidateSpec` | type | Candidate file spec |

### From `cli.ts` (Phase 3)

| Export | Kind | Description |
|---|---|---|
| `parseAgentFlags` | function | Parse `--agent` mode CLI flags |
| `AgentModeFlags` | type | Parsed agent mode flag values |

---

## Implementation Notes

1. **Docs-sync rule applies.** Every `.mdx` file change must be mirrored in the corresponding `.md` file, and vice versa. MDX components (`<CodeGroup>`, `<Note>`, `<Warning>`) are converted to plain markdown equivalents.

2. **README changes are minimal.** The README gets a concise "Agent Mode" section with the three canonical examples and a flag reference table. Detailed usage goes in the dedicated `docs/agent-flag.md` guide.

3. **CLI help text is the source of truth.** The `printUsage()` function in `cli.ts` is the canonical flag reference. README and docs should match it exactly.

4. **SDK reference uses runnable examples.** All code examples in the SDK reference section must be valid TypeScript that a consumer can copy-paste into their project.

5. **No new dependencies.** This phase only modifies documentation files and the `printUsage()` function. No npm packages, no new source modules.

6. **Phase 3 help text may need updating.** Phase 3 defined the initial `printUsage()` content. This phase ensures it is complete and includes all examples. If Phase 3 already implemented the full help text, this phase validates it matches the final API.

---

## Acceptance Criteria

- [ ] `README.md` includes an "Agent Mode" section with basic, context, and dry-run examples
- [ ] `README.md` flag reference table matches all flags from `parseAgentFlags()` in Phase 3
- [ ] `README.md` persona reference table lists all 13 production intents with correct preset/pattern
- [ ] `printUsage()` in `cli.ts` displays complete help text covering both YAML and agent modes
- [ ] `printUsage()` examples are valid, runnable commands
- [ ] `docs/agent-flag.md` exists with comprehensive usage guide (8+ examples)
- [ ] `web/content/docs/agent-flag.mdx` exists as the MDX mirror with correct frontmatter
- [ ] `docs/reference-sdk.md` includes persona-utils and workflow-generator API documentation
- [ ] `web/content/docs/reference-sdk.mdx` mirrors the SDK reference additions
- [ ] All code examples in docs are valid TypeScript with correct import paths (`@agent-relay/sdk/workflows`)
- [ ] SDK export tables list all public functions, constants, and types from Phases 1–3
- [ ] Docs-sync rule is satisfied: every `.mdx` change has a corresponding `.md` mirror
- [ ] No broken markdown formatting (tables render correctly, code blocks have language tags)
- [ ] `--help` output matches documented flag descriptions
```
