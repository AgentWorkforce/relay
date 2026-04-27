# Phase 2 Specification: Workflow Generator Module

> Generate complete, runnable workflow TypeScript files from a `WorkflowGeneratorInput` using the SDK `WorkflowBuilder` API.

**Phase:** 2 of 5
**Dependencies:** Phase 1 (persona-utils — provides `WorkflowGeneratorInput`, `PersonaResolution`, `ContextFileSpec`, `VerificationSpec`, `SkillMaterializationPlan`)
**Target files:**

- `packages/sdk/src/workflows/workflow-generator.ts` (new)
- `packages/sdk/src/workflows/__tests__/workflow-generator.test.ts` (new)

---

## Goal

Create a workflow generator module that transforms a `WorkflowGeneratorInput` (produced by Phase 1 persona resolution + CLI flag parsing) into a complete, self-contained TypeScript workflow file. The generated file uses the SDK's `WorkflowBuilder` API (`workflow()`, `.agent()`, `.step()`, `.run()`) and follows the six-phase execution model:

1. **Bootstrap** — set up the workflow, declare agents, configure the swarm pattern
2. **Skills** — install any required skills/tools for the agent persona
3. **Context** — read context files via deterministic shell steps
4. **Task** — execute the main agent task, referencing context outputs via `{{steps.X.output}}`
5. **Verification** — run verification commands to validate results
6. **Final** — complete the workflow with a summary step

The generator must produce valid TypeScript that can be written to disk and executed directly via `npx tsx <file>` or `agent-relay run`.

---

## Architecture Overview

```
WorkflowGeneratorInput
        │
        ▼
 generateWorkflow()
        │
        ├── emitBootstrapPhase()   → imports, workflow(), .pattern(), .channel(), agents
        ├── emitSkillPhase()       → deterministic steps for skill installs
        ├── emitContextPhase()     → deterministic steps to capture file contents
        ├── emitTaskPhase()        → agent step(s) with {{steps.X.output}} chaining
        ├── emitVerificationPhase()→ deterministic steps with exit_code verification
        └── emitFinalPhase()       → summary step, .onError(), .run()
        │
        ▼
  GeneratedWorkflow
  (source: string, metadata: WorkflowMetadata)
```

---

## TypeScript Interfaces

### GeneratedWorkflow

```ts
/**
 * Output of the workflow generator.
 */
export interface GeneratedWorkflow {
  /** Complete TypeScript source code for the workflow file. */
  source: string;
  /** Metadata about the generated workflow for tooling/logging. */
  metadata: WorkflowMetadata;
}
```

### WorkflowMetadata

```ts
/**
 * Metadata about a generated workflow — used for logging, dry-run reports,
 * and trajectory recording.
 */
export interface WorkflowMetadata {
  /** Workflow name (slugified from task description). */
  name: string;
  /** Swarm pattern used. */
  pattern: SwarmPattern;
  /** Agent preset used. */
  preset: AgentPreset;
  /** Number of agents declared. */
  agentCount: number;
  /** Total number of steps generated. */
  stepCount: number;
  /** Breakdown of steps by phase. */
  phases: {
    bootstrap: number;
    skills: number;
    context: number;
    task: number;
    verification: number;
    final: number;
  };
  /** Whether the workflow was generated with skill installs. */
  hasSkills: boolean;
  /** Whether the workflow includes verification steps. */
  hasVerification: boolean;
  /** Estimated execution waves (for dry-run preview). */
  estimatedWaves: number;
}
```

### WorkflowGeneratorOptions

```ts
/**
 * Options that control code generation behavior (not the workflow itself).
 */
export interface WorkflowGeneratorOptions {
  /** Indent style: 'spaces' (default) or 'tabs'. */
  indent?: 'spaces' | 'tabs';
  /** Number of spaces per indent level (default: 2). */
  indentSize?: number;
  /** Include inline comments in generated code (default: true). */
  comments?: boolean;
  /** Include a header comment with generation metadata (default: true). */
  header?: boolean;
}
```

### Re-exported from Phase 1

The following types are consumed directly from `persona-utils.ts` (Phase 1):

- `WorkflowGeneratorInput` — primary input
- `PersonaResolution` — resolved persona with intent, preset, pattern
- `PersonaProfile` — persona details
- `ContextFileSpec` — `{ stepName, command }` for context-gathering steps
- `VerificationSpec` — `{ stepName, command }` for verification steps
- `SkillMaterializationPlan` — `{ installs, manifestPath }` for skill setup

---

## Function Specifications

### `generateWorkflow(input: WorkflowGeneratorInput, options?: WorkflowGeneratorOptions): GeneratedWorkflow`

Main entry point. Orchestrates all `emit*` functions and concatenates their output into a complete TypeScript source string.

```ts
import type { WorkflowGeneratorInput } from './persona-utils.js';

/**
 * Generate a complete workflow TypeScript file from a WorkflowGeneratorInput.
 *
 * @param input - Resolved persona, task description, context files, and verifications
 * @param options - Code generation options (indent style, comments, etc.)
 * @returns Generated workflow source code and metadata
 */
export function generateWorkflow(
  input: WorkflowGeneratorInput,
  options?: WorkflowGeneratorOptions
): GeneratedWorkflow {
  const opts = resolveOptions(options);
  const lines: string[] = [];

  lines.push(...emitBootstrapPhase(input, opts));
  lines.push(...emitSkillPhase(input, opts));
  lines.push(...emitContextPhase(input, opts));
  lines.push(...emitTaskPhase(input, opts));
  lines.push(...emitVerificationPhase(input, opts));
  lines.push(...emitFinalPhase(input, opts));

  const source = lines.join('\n');
  const metadata = computeMetadata(input);

  return { source, metadata };
}
```

**Behavior:**

1. Resolves default options via `resolveOptions()`
2. Calls each `emit*` function in order, collecting lines
3. Joins lines with newlines
4. Computes metadata from the input
5. Returns `{ source, metadata }`

---

### `emitBootstrapPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[]`

Generates the file header, imports, `main()` function opening, `workflow()` call, `.description()`, `.pattern()`, `.channel()`, `.maxConcurrency()`, `.timeout()`, and all `.agent()` declarations.

```ts
/**
 * Emit the bootstrap phase: imports, workflow declaration, agent definitions.
 */
export function emitBootstrapPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[] {
  // ...
}
```

**Generated code structure:**

```ts
/**
 * Auto-generated workflow: {workflowName}
 * Persona: {persona.name} ({selection.intent})
 * Pattern: {selection.pattern} | Preset: {selection.preset}
 * Generated: {ISO timestamp}
 */
import { workflow } from '@agent-relay/sdk/workflows';

async function main() {
  const result = await workflow('{workflowName}')
    .description('{taskDescription}')
    .pattern('{selection.pattern}')
    .channel('wf-{workflowName}')
    .maxConcurrency({maxConcurrency})
    .timeout({timeout})

    .agent('{agentName}', {
      cli: 'claude',
      preset: '{selection.preset}',
      role: '{persona.description || taskDescription}',
      retries: 2,
    })
```

**Agent naming rules:**

- Single agent workflows use `{intent}-agent` as the agent name (e.g., `review-agent`, `debugging-agent`)
- The agent's `cli` defaults to `'claude'`; can be overridden by persona metadata
- The `role` is derived from `persona.description` or falls back to the task description
- `preset` comes directly from `selection.preset`

---

### `emitSkillPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[]`

Generates deterministic steps for each skill install in the `SkillMaterializationPlan`. Emitted only if `input.skillPlan.installs.length > 0`.

```ts
/**
 * Emit skill installation steps (deterministic shell commands).
 * Skipped entirely if no skills need to be installed.
 */
export function emitSkillPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[] {
  // ...
}
```

**Generated code structure (per install):**

```ts
    .step('install-skill-{skillId}', {
      type: 'deterministic',
      command: '{install.command}',
      failOnError: true,
    })
```

**Behavior:**

- Each install in `skillPlan.installs` becomes a deterministic step
- Step names are slugified: `install-skill-{skillId}`
- All skill steps are independent (no `dependsOn` between them) so they can run in parallel
- If `skillPlan.manifestPath` is set, an additional step reads the manifest for verification

---

### `emitContextPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[]`

Generates deterministic steps to capture context files. Each `ContextFileSpec` becomes a step whose stdout output is available to downstream agent steps via `{{steps.{stepName}.output}}`.

```ts
/**
 * Emit context-gathering steps (deterministic shell commands).
 * Each step captures a file or command output for downstream agent consumption.
 */
export function emitContextPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[] {
  // ...
}
```

**Generated code structure (per context file):**

```ts
    .step('{contextFile.stepName}', {
      type: 'deterministic',
      command: '{contextFile.command}',
      captureOutput: true,
      dependsOn: [{...skillStepNames}],  // depend on skill installs if any
    })
```

**Behavior:**

- Each `ContextFileSpec` in `input.contextFiles` produces one deterministic step
- Steps use `captureOutput: true` so their stdout is available via `{{steps.X.output}}`
- If skill steps exist, context steps depend on all skill steps (skills must install before context reads)
- Context steps are independent of each other (parallelizable within the DAG)
- Empty `contextFiles` array produces no steps

---

### `emitTaskPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[]`

Generates the main agent step(s) that perform the actual task. The task prompt is composed from the original `taskDescription` augmented with references to context step outputs.

```ts
/**
 * Emit the main task execution step(s).
 * For DAG patterns: a single agent step referencing all context outputs.
 * For pipeline patterns: sequential agent steps with chained outputs.
 */
export function emitTaskPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[] {
  // ...
}
```

**Generated code structure (DAG pattern — single task step):**

```ts
    .step('execute-task', {
      agent: '{agentName}',
      task: `{taskDescription}

Context:
{{steps.{context1.stepName}.output}}
{{steps.{context2.stepName}.output}}
...`,
      dependsOn: [{...contextStepNames}],
      verification: { type: 'exit_code', value: '0' },
      retries: 2,
    })
```

**Generated code structure (pipeline pattern — sequential steps):**

```ts
    .step('analyze-{n}', {
      agent: '{agentName}',
      task: `Phase {n}: {subTask}

Input:
{{steps.{previousStep}.output}}`,
      dependsOn: ['{previousStep}'],
      verification: { type: 'exit_code', value: '0' },
    })
```

**Behavior:**

- **DAG pattern**: Generates a single `execute-task` step that depends on all context steps. The task prompt includes all context outputs interpolated via `{{steps.X.output}}`.
- **Pipeline pattern**: Generates sequential agent steps where each step depends on the previous one. The first step references context outputs; subsequent steps reference the output of the preceding step.
- The agent name matches the one declared in the bootstrap phase
- Verification defaults to `exit_code` check
- Retries default to 2 for the primary task step

**Task prompt composition:**

```ts
function composeTaskPrompt(taskDescription: string, contextStepNames: string[]): string {
  if (contextStepNames.length === 0) {
    return taskDescription;
  }

  const contextRefs = contextStepNames.map((name) => `{{steps.${name}.output}}`).join('\n');

  return `${taskDescription}\n\nContext:\n${contextRefs}`;
}
```

---

### `emitVerificationPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[]`

Generates deterministic verification steps. Each `VerificationSpec` produces a step that runs a shell command and asserts `exit_code === 0`.

```ts
/**
 * Emit verification steps (deterministic shell commands with exit_code checks).
 * Skipped entirely if no verifications are specified.
 */
export function emitVerificationPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[] {
  // ...
}
```

**Generated code structure (per verification):**

```ts
    .step('{verification.stepName}', {
      type: 'deterministic',
      command: '{verification.command}',
      failOnError: true,
      dependsOn: ['execute-task'],
    })
```

**Behavior:**

- Each `VerificationSpec` in `input.verifications` produces one deterministic step
- All verification steps depend on the task step(s) completing first
- `failOnError: true` ensures the workflow fails if any verification fails
- Empty `verifications` array produces no steps

---

### `emitFinalPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[]`

Generates the workflow's closing: `.onError()` strategy, `.run()` call, and the `main()` function wrapper.

```ts
/**
 * Emit the final phase: error handling, run invocation, main() wrapper.
 */
export function emitFinalPhase(input: WorkflowGeneratorInput, opts: ResolvedOptions): string[] {
  // ...
}
```

**Generated code structure:**

```ts
    .onError('fail-fast')
    .run();

  console.log('Workflow completed:', result.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Behavior:**

- Error strategy defaults to `'fail-fast'`
- The `.run()` call has no arguments (uses default cwd)
- If `input.outputFile` is set, adds a `console.log` with the output path
- Closes the `main()` function and adds the top-level error handler

---

## Internal Helper Functions

### `resolveOptions(options?: WorkflowGeneratorOptions): ResolvedOptions`

```ts
interface ResolvedOptions {
  indent: string; // computed indent string (e.g., '  ')
  comments: boolean;
  header: boolean;
}

function resolveOptions(options?: WorkflowGeneratorOptions): ResolvedOptions {
  const style = options?.indent ?? 'spaces';
  const size = options?.indentSize ?? 2;
  return {
    indent: style === 'tabs' ? '\t' : ' '.repeat(size),
    comments: options?.comments ?? true,
    header: options?.header ?? true,
  };
}
```

### `computeMetadata(input: WorkflowGeneratorInput): WorkflowMetadata`

Counts steps per phase and computes estimated waves from the dependency graph.

```ts
function computeMetadata(input: WorkflowGeneratorInput): WorkflowMetadata {
  const skillSteps = input.skillPlan.installs.length;
  const contextSteps = input.contextFiles.length;
  const taskSteps = input.selection.pattern === 'pipeline' ? 3 : 1; // pipeline splits into analyze/execute/synthesize
  const verificationSteps = input.verifications.length;

  // Wave estimation:
  // Wave 1: skill installs (parallel)
  // Wave 2: context reads (parallel, depend on skills)
  // Wave 3+: task steps (1 for DAG, N for pipeline)
  // Wave N+1: verification steps (parallel, depend on task)
  // Wave N+2: final summary
  let waves = 1; // always at least the task wave
  if (skillSteps > 0) waves++;
  if (contextSteps > 0) waves++;
  if (verificationSteps > 0) waves++;
  waves++; // final
  if (input.selection.pattern === 'pipeline') {
    waves += taskSteps - 1; // pipeline adds sequential waves
  }

  return {
    name: input.workflowName,
    pattern: input.selection.pattern,
    preset: input.selection.preset,
    agentCount: 1,
    stepCount: skillSteps + contextSteps + taskSteps + verificationSteps + 1,
    phases: {
      bootstrap: 0, // bootstrap has no steps, just configuration
      skills: skillSteps,
      context: contextSteps,
      task: taskSteps,
      verification: verificationSteps,
      final: 1,
    },
    hasSkills: skillSteps > 0,
    hasVerification: verificationSteps > 0,
    estimatedWaves: waves,
  };
}
```

### `slugify(text: string): string`

Converts a task description into a valid workflow name.

```ts
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
```

### `escapeTemplateString(text: string): string`

Escapes backticks and `${` sequences inside generated template literals.

```ts
function escapeTemplateString(text: string): string {
  return text.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}
```

---

## Complete Generation Example

Given this input:

```ts
const input: WorkflowGeneratorInput = {
  taskDescription: 'Review the authentication middleware for security vulnerabilities',
  workflowName: 'review-auth-middleware',
  persona: {
    id: 'security-reviewer-v1',
    name: 'Security Reviewer',
    description: 'Reviews code for security vulnerabilities and OWASP risks',
    intent: 'security-review',
    preset: 'analyst',
    pattern: 'dag',
  },
  selection: {
    persona: {
      /* same as above */
    },
    intent: 'security-review',
    preset: 'analyst',
    pattern: 'dag',
    resolved: true,
    resolutionType: 'intent',
  },
  skillPlan: { installs: [] },
  contextFiles: [
    {
      stepName: 'read-auth-middleware',
      command: 'cat src/middleware/auth.ts',
    },
    {
      stepName: 'read-auth-tests',
      command: 'cat src/middleware/__tests__/auth.test.ts',
    },
  ],
  verifications: [
    {
      stepName: 'verify-no-eval',
      command: "! grep -r 'eval(' src/middleware/auth.ts",
    },
  ],
  outputFile: 'reports/security-review.md',
  maxConcurrency: 4,
  timeout: 3_600_000,
};
```

The generator produces:

```ts
/**
 * Auto-generated workflow: review-auth-middleware
 * Persona: Security Reviewer (security-review)
 * Pattern: dag | Preset: analyst
 * Generated: 2026-04-10T12:00:00.000Z
 */
import { workflow } from '@agent-relay/sdk/workflows';

async function main() {
  const result = await workflow('review-auth-middleware')
    .description('Review the authentication middleware for security vulnerabilities')
    .pattern('dag')
    .channel('wf-review-auth-middleware')
    .maxConcurrency(4)
    .timeout(3600000)

    .agent('security-review-agent', {
      cli: 'claude',
      preset: 'analyst',
      role: 'Reviews code for security vulnerabilities and OWASP risks',
      retries: 2,
    })

    // ── Context phase ─────────────────────────────────────────────────────
    .step('read-auth-middleware', {
      type: 'deterministic',
      command: 'cat src/middleware/auth.ts',
      captureOutput: true,
    })

    .step('read-auth-tests', {
      type: 'deterministic',
      command: 'cat src/middleware/__tests__/auth.test.ts',
      captureOutput: true,
    })

    // ── Task phase ────────────────────────────────────────────────────────
    .step('execute-task', {
      agent: 'security-review-agent',
      task: `Review the authentication middleware for security vulnerabilities

Context:
{{steps.read-auth-middleware.output}}
{{steps.read-auth-tests.output}}`,
      dependsOn: ['read-auth-middleware', 'read-auth-tests'],
      verification: { type: 'exit_code', value: '0' },
      retries: 2,
    })

    // ── Verification phase ────────────────────────────────────────────────
    .step('verify-no-eval', {
      type: 'deterministic',
      command: "! grep -r 'eval(' src/middleware/auth.ts",
      failOnError: true,
      dependsOn: ['execute-task'],
    })

    .onError('fail-fast')
    .run();

  console.log('Workflow completed:', result.status);
  console.log('Output:', 'reports/security-review.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

---

## Pipeline Pattern Example

For a pipeline-pattern workflow (e.g., `requirements-analysis`), the task phase generates sequential steps:

```ts
    // ── Task phase (pipeline) ─────────────────────────────────────────────
    .step('analyze', {
      agent: 'requirements-analysis-agent',
      task: `Analyze the following context and identify requirements:

Context:
{{steps.read-spec.output}}
{{steps.read-readme.output}}`,
      dependsOn: ['read-spec', 'read-readme'],
      verification: { type: 'exit_code', value: '0' },
    })

    .step('synthesize', {
      agent: 'requirements-analysis-agent',
      task: `Synthesize the analysis into structured requirements:

Analysis:
{{steps.analyze.output}}`,
      dependsOn: ['analyze'],
      verification: { type: 'exit_code', value: '0' },
    })

    .step('validate', {
      agent: 'requirements-analysis-agent',
      task: `Validate the requirements for completeness and consistency:

Requirements:
{{steps.synthesize.output}}`,
      dependsOn: ['synthesize'],
      verification: { type: 'exit_code', value: '0' },
    })
```

---

## File: `packages/sdk/src/workflows/workflow-generator.ts`

### Structure

```
workflow-generator.ts
  ├── Type exports (GeneratedWorkflow, WorkflowMetadata, WorkflowGeneratorOptions)
  ├── Internal types (ResolvedOptions)
  ├── Helper functions (resolveOptions, computeMetadata, slugify, escapeTemplateString)
  ├── composeTaskPrompt()
  ├── emitBootstrapPhase()
  ├── emitSkillPhase()
  ├── emitContextPhase()
  ├── emitTaskPhase()
  ├── emitVerificationPhase()
  ├── emitFinalPhase()
  └── generateWorkflow()          ← main export
```

### Imports

```ts
import type { AgentPreset, SwarmPattern } from './types.js';
import type {
  WorkflowGeneratorInput,
  ContextFileSpec,
  VerificationSpec,
  SkillMaterializationPlan,
  PersonaResolution,
  PersonaProfile,
} from './persona-utils.js';
```

Only depends on types from Phase 1 (`persona-utils.ts`) and the existing `types.ts`. No external dependencies.

---

## File: `packages/sdk/src/workflows/__tests__/workflow-generator.test.ts`

### Test structure (vitest)

```ts
import { describe, it, expect } from 'vitest';
import {
  generateWorkflow,
  emitBootstrapPhase,
  emitSkillPhase,
  emitContextPhase,
  emitTaskPhase,
  emitVerificationPhase,
  emitFinalPhase,
  type GeneratedWorkflow,
  type WorkflowMetadata,
} from '../workflow-generator.js';
import type { WorkflowGeneratorInput } from '../persona-utils.js';
```

### Test Fixtures

```ts
function createMinimalInput(overrides?: Partial<WorkflowGeneratorInput>): WorkflowGeneratorInput {
  return {
    taskDescription: 'Test task',
    workflowName: 'test-task',
    persona: {
      id: 'code-worker-v1',
      name: 'Code Worker',
      intent: 'code-gen',
      preset: 'worker',
      pattern: 'dag',
    },
    selection: {
      intent: 'code-gen',
      preset: 'worker',
      pattern: 'dag',
      resolved: true,
      resolutionType: 'intent',
    },
    skillPlan: { installs: [] },
    contextFiles: [],
    verifications: [],
    maxConcurrency: 4,
    timeout: 3_600_000,
    ...overrides,
  };
}

function createFullInput(): WorkflowGeneratorInput {
  return createMinimalInput({
    taskDescription: 'Review auth middleware for security issues',
    workflowName: 'review-auth-middleware',
    persona: {
      id: 'security-reviewer-v1',
      name: 'Security Reviewer',
      description: 'Reviews code for security vulnerabilities',
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
    skillPlan: {
      installs: [{ skillId: 'semgrep', command: 'npm install -g semgrep' }],
    },
    contextFiles: [
      { stepName: 'read-auth', command: 'cat src/auth.ts' },
      { stepName: 'read-tests', command: 'cat src/auth.test.ts' },
    ],
    verifications: [{ stepName: 'verify-no-eval', command: "! grep -r 'eval(' src/" }],
    outputFile: 'reports/security.md',
  });
}
```

### Test Cases

#### `generateWorkflow`

| Test                                       | Input                                                                 | Assertions                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimal input produces valid TypeScript    | `createMinimalInput()`                                                | Source contains `import { workflow }`, `async function main()`, `.run()`, `main().catch`                                                       |
| Full input includes all phases             | `createFullInput()`                                                   | Source contains skill install step, both context steps, task step, verification step                                                           |
| Metadata is accurate                       | `createFullInput()`                                                   | `metadata.stepCount === 5` (1 skill + 2 context + 1 task + 1 verification), `metadata.hasSkills === true`, `metadata.hasVerification === true` |
| Workflow name appears in source            | `createMinimalInput()`                                                | Source contains `workflow('test-task')`                                                                                                        |
| Pattern is set from selection              | `createMinimalInput({ selection: { ...base, pattern: 'pipeline' } })` | Source contains `.pattern('pipeline')`                                                                                                         |
| Channel name is derived from workflow name | `createMinimalInput()`                                                | Source contains `.channel('wf-test-task')`                                                                                                     |
| Max concurrency is configurable            | `createMinimalInput({ maxConcurrency: 8 })`                           | Source contains `.maxConcurrency(8)`                                                                                                           |
| Timeout is configurable                    | `createMinimalInput({ timeout: 1_800_000 })`                          | Source contains `.timeout(1800000)`                                                                                                            |
| Output file produces console.log           | `createMinimalInput({ outputFile: 'out.md' })`                        | Source contains `'out.md'`                                                                                                                     |
| No output file omits log                   | `createMinimalInput()`                                                | Source does not contain `Output:`                                                                                                              |

#### `emitBootstrapPhase`

| Test                                      | Input                                    | Assertions                                                              |
| ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Includes import statement                 | Any                                      | Output contains `import { workflow } from '@agent-relay/sdk/workflows'` |
| Includes header comment when enabled      | `{ header: true }`                       | Output starts with `/**`                                                |
| Omits header comment when disabled        | `{ header: false }`                      | First line is `import`                                                  |
| Agent name follows intent convention      | `{ selection.intent: 'review' }`         | Output contains `'review-agent'`                                        |
| Agent preset matches selection            | `{ selection.preset: 'analyst' }`        | Output contains `preset: 'analyst'`                                     |
| Agent role uses persona description       | `{ persona.description: 'Custom role' }` | Output contains `role: 'Custom role'`                                   |
| Agent role falls back to task description | `{ persona: { id: 'x', name: 'X' } }`    | Output contains `role: '{taskDescription}'`                             |

#### `emitSkillPhase`

| Test                                     | Input                                                      | Assertions                                           |
| ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| No skills produces empty array           | `{ skillPlan: { installs: [] } }`                          | `result.length === 0`                                |
| Single install produces one step         | `{ installs: [{ skillId: 'foo', command: 'npm i foo' }] }` | Output contains `'install-skill-foo'`, `'npm i foo'` |
| Multiple installs produce parallel steps | Two installs                                               | Neither step has `dependsOn` referencing the other   |
| Steps are deterministic                  | Any install                                                | Output contains `type: 'deterministic'`              |
| Fail on error is set                     | Any install                                                | Output contains `failOnError: true`                  |

#### `emitContextPhase`

| Test                                        | Input                  | Assertions                                                |
| ------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| No context files produces empty array       | `{ contextFiles: [] }` | `result.length === 0`                                     |
| Single context file produces one step       | One `ContextFileSpec`  | Output contains step name and command                     |
| Capture output is enabled                   | Any context file       | Output contains `captureOutput: true`                     |
| Steps depend on skill steps when present    | Skills + context       | Output contains `dependsOn: ['install-skill-...']`        |
| Steps have no dependencies when no skills   | No skills, has context | No `dependsOn` in context steps                           |
| Context steps are independent of each other | Multiple context files | No context step lists another context step in `dependsOn` |

#### `emitTaskPhase`

| Test                                              | Input                     | Assertions                                                                         |
| ------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| DAG produces single execute-task step             | `{ pattern: 'dag' }`      | Output contains exactly one `.step('execute-task'`                                 |
| Pipeline produces sequential steps                | `{ pattern: 'pipeline' }` | Output contains `'analyze'`, `'synthesize'`, `'validate'` with chained `dependsOn` |
| Task step depends on all context steps            | 2 context files           | `dependsOn` array includes both context step names                                 |
| Task step depends on task step when no context    | No context files          | `dependsOn` is empty or omitted                                                    |
| Context outputs are interpolated into task prompt | 2 context files           | Output contains `{{steps.read-auth.output}}`                                       |
| Task description appears in agent task            | Any                       | Output contains the `taskDescription` string                                       |
| Retries default to 2                              | Any                       | Output contains `retries: 2`                                                       |
| Verification defaults to exit_code                | Any                       | Output contains `type: 'exit_code'`                                                |

#### `emitVerificationPhase`

| Test                                            | Input                   | Assertions                                              |
| ----------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| No verifications produces empty array           | `{ verifications: [] }` | `result.length === 0`                                   |
| Single verification produces one step           | One `VerificationSpec`  | Output contains step name, command, `failOnError: true` |
| Verification steps depend on task step          | DAG pattern             | `dependsOn` includes `'execute-task'`                   |
| Verification steps depend on last pipeline step | Pipeline pattern        | `dependsOn` includes `'validate'`                       |

#### `emitFinalPhase`

| Test                              | Input | Assertions                              |
| --------------------------------- | ----- | --------------------------------------- |
| Includes onError                  | Any   | Output contains `.onError('fail-fast')` |
| Includes run() call               | Any   | Output contains `.run()`                |
| Closes main function              | Any   | Output contains `main().catch`          |
| Includes process.exit(1) on error | Any   | Output contains `process.exit(1)`       |

#### `WorkflowMetadata`

| Test                                    | Input                 | Assertions                                                                                        |
| --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| Step count is sum of all phases         | Full input            | `stepCount === phases.skills + phases.context + phases.task + phases.verification + phases.final` |
| Agent count is 1                        | Any                   | `agentCount === 1`                                                                                |
| Estimated waves for DAG with all phases | Full input            | `estimatedWaves >= 4` (skills + context + task + verification + final)                            |
| Estimated waves for minimal input       | Minimal               | `estimatedWaves === 2` (task + final)                                                             |
| Pipeline adds extra waves               | Pipeline with context | `estimatedWaves > DAG equivalent`                                                                 |

#### Edge Cases

| Test                                      | Scenario                                 | Assertions                                    |
| ----------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| Backticks in task description are escaped | `taskDescription: 'Use \`code\` blocks'` | Generated template literal doesn't break      |
| Dollar braces in commands are escaped     | `command: 'echo ${HOME}'`                | Generated source is valid TypeScript          |
| Very long task description is handled     | 2000-char description                    | Source is valid, no truncation                |
| Empty task description                    | `taskDescription: ''`                    | Produces valid (if minimal) workflow          |
| Special characters in workflow name       | `workflowName: 'review-auth_v2.1'`       | Valid workflow name used in `workflow()` call |

---

## SDK Export Changes

Add to `packages/sdk/src/workflows/index.ts`:

```ts
export {
  generateWorkflow,
  emitBootstrapPhase,
  emitSkillPhase,
  emitContextPhase,
  emitTaskPhase,
  emitVerificationPhase,
  emitFinalPhase,
  type GeneratedWorkflow,
  type WorkflowMetadata,
  type WorkflowGeneratorOptions,
} from './workflow-generator.js';
```

---

## Implementation Notes

1. **No external dependencies.** The module only imports types from `persona-utils.ts` (Phase 1) and `types.ts`. No npm packages, no network calls, no filesystem access. The generator is a pure function: input in, string out.

2. **String-based code generation.** The generator builds TypeScript source as an array of string lines. This is intentional — it avoids AST manipulation complexity and keeps the module lightweight. The generated code is formatted consistently via the `ResolvedOptions` indent configuration.

3. **Template literal safety.** All user-provided strings (task descriptions, commands, file paths) are escaped before being embedded in generated template literals. `escapeTemplateString()` handles backtick and `${` escaping.

4. **Forward-compatible with Phase 3.** The CLI integration (Phase 3) will call `generateWorkflow()` with a `WorkflowGeneratorInput` assembled from parsed CLI flags and Phase 1 persona resolution. The generator does not assume how its input is constructed.

5. **Emit functions are independently testable.** Each `emit*` function accepts the full `WorkflowGeneratorInput` and returns `string[]`. This allows unit tests to validate individual phases without generating the entire workflow.

6. **Pattern follows existing codebase conventions.** The file uses ES module imports with `.js` extensions, `type` keyword for type-only imports, and JSDoc comments for exported functions — matching the patterns in `builder.ts` and `types.ts`.

7. **Pipeline step names.** For pipeline patterns, the three sequential task steps use fixed names: `'analyze'`, `'synthesize'`, `'validate'`. This convention aligns with the sequential nature of analysis workflows and provides predictable step names for verification dependencies.

---

## Acceptance Criteria

- [ ] `generateWorkflow()` produces valid TypeScript source that can be parsed without syntax errors
- [ ] Generated workflows use the correct `WorkflowBuilder` API methods (`.workflow()`, `.agent()`, `.step()`, `.pattern()`, `.run()`)
- [ ] DAG pattern generates a single `execute-task` step with parallel context dependencies
- [ ] Pipeline pattern generates sequential `analyze` → `synthesize` → `validate` steps with chained `dependsOn`
- [ ] Context outputs are correctly referenced via `{{steps.X.output}}` interpolation in task prompts
- [ ] Skill install steps are generated as deterministic steps when `skillPlan.installs` is non-empty
- [ ] Verification steps are generated as deterministic steps with `failOnError: true`
- [ ] Agent preset and pattern match the `PersonaResolution` from Phase 1
- [ ] `WorkflowMetadata` accurately reflects step counts and estimated waves
- [ ] Special characters in task descriptions and commands are properly escaped
- [ ] Empty optional fields (no skills, no context, no verifications) produce valid minimal workflows
- [ ] All emit functions are exported and independently testable
- [ ] All tests pass via `vitest`
- [ ] No new external dependencies introduced
- [ ] Types are exported and available to Phase 3 consumers
