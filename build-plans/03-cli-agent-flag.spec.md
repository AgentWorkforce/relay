# Phase 3 Specification: CLI `--agent` Flag Integration

> Wire the `--agent` flag into the CLI entry point so that `relay-workflow "task description" --agent <ref>` resolves a persona, generates a workflow, and executes it — all in one command.

**Phase:** 3 of 5
**Dependencies:** Phase 1 (persona-utils), Phase 2 (workflow-generator)
**Target files:**

- `packages/sdk/src/workflows/cli.ts` (modify)
- `packages/sdk/src/workflows/context-heuristics.ts` (new)
- `packages/sdk/src/workflows/__tests__/context-heuristics.test.ts` (new)

---

## Goal

Extend the existing CLI (`packages/sdk/src/workflows/cli.ts`) to support a new **agent mode** activated by the `--agent` flag. When present, the CLI bypasses the YAML-based workflow path and instead:

1. Parses task description and all `--agent`-related flags
2. Resolves the persona via `resolvePersonaByIdOrIntent()` (Phase 1)
3. Infers default context files based on intent heuristics (if `--context` not supplied)
4. Calls `generateWorkflow()` (Phase 2) to produce a runnable workflow
5. Optionally writes the generated workflow to disk (`--output`)
6. Optionally prints a dry-run report instead of executing (`--dry-run`)
7. Executes the generated workflow via `WorkflowRunner`

This creates a zero-config experience: `relay-workflow "Review auth for vulnerabilities" --agent security-review` is a single command that does everything.

---

## New CLI Flags

### Flag Definitions

| Flag                | Short | Type       | Default      | Description                                                            |
| ------------------- | ----- | ---------- | ------------ | ---------------------------------------------------------------------- |
| `--agent <ref>`     | `-a`  | `string`   | —            | Persona ID or intent string. **Required** for agent mode.              |
| `--profile <id>`    | `-p`  | `string`   | —            | Disambiguation hint when multiple personas share an intent.            |
| `--tier <tier>`     | `-t`  | `string`   | `'standard'` | Execution tier: `'standard'` or `'premium'`. Controls model selection. |
| `--dry-run`         | `-d`  | `boolean`  | `false`      | Print the generated workflow and metadata without executing.           |
| `--context <path>`  | `-c`  | `string[]` | (heuristic)  | Context files to read. Repeatable. Overrides heuristics when provided. |
| `--verify <cmd>`    | `-v`  | `string[]` | `[]`         | Verification commands. Repeatable. Each must exit 0.                   |
| `--output <path>`   | `-o`  | `string`   | —            | Write generated workflow source to this file path.                     |
| `--concurrency <n>` |       | `number`   | `4`          | Max concurrent steps in the generated workflow.                        |
| `--timeout <ms>`    |       | `number`   | `3600000`    | Workflow timeout in milliseconds (default: 1 hour).                    |

### Flag Parsing Rules

1. `--agent` is the mode switch. If present, the CLI enters agent mode. If absent, the existing YAML-based path is used unchanged.
2. In agent mode, the first positional argument is the **task description** (not a YAML path).
3. `--context` and `--verify` are repeatable: `--context src/auth.ts --context src/auth.test.ts`.
4. `--dry-run` is a boolean flag (no value). It replaces the existing `DRY_RUN` env var behavior in agent mode.
5. All existing flags (`--resume`, `--workflow`, `--start-from`, `--previous-run-id`, `--validate`) remain unchanged and are **mutually exclusive** with `--agent`.

### Updated `FLAGS_WITH_VALUES`

```ts
const FLAGS_WITH_VALUES = new Set([
  '--resume',
  '--workflow',
  '--start-from',
  '--previous-run-id',
  '--agent',
  '-a',
  '--profile',
  '-p',
  '--tier',
  '-t',
  '--context',
  '-c',
  '--verify',
  '-v',
  '--output',
  '-o',
  '--concurrency',
  '--timeout',
]);
```

---

## Updated Usage Help

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

  # Agent mode
  relay-workflow "Review auth for vulnerabilities" --agent security-review
  relay-workflow "Fix flaky test in CI" --agent debugging --context tests/flaky.test.ts
  relay-workflow "Write API docs" --agent documentation --dry-run
  relay-workflow "Refactor auth module" -a code-gen -c src/auth.ts -o workflow.ts
`.trim()
  );
}
```

---

## CLI Parsing Implementation

### `parseAgentFlags(args: string[]): AgentModeFlags | null`

Returns `null` if `--agent` / `-a` is not present (fall through to YAML mode). Otherwise extracts all agent-mode flags.

```ts
export interface AgentModeFlags {
  taskDescription: string;
  agentRef: string;
  profile?: string;
  tier: 'standard' | 'premium';
  dryRun: boolean;
  contextPaths: string[];
  verifyCommands: string[];
  outputPath?: string;
  concurrency: number;
  timeout: number;
}

export function parseAgentFlags(args: string[]): AgentModeFlags | null {
  // Check for --agent or -a
  const agentIdx = args.indexOf('--agent') !== -1 ? args.indexOf('--agent') : args.indexOf('-a');

  if (agentIdx === -1) return null;

  const agentRef = args[agentIdx + 1];
  if (!agentRef || agentRef.startsWith('-')) {
    throw new Error('--agent requires a persona ID or intent value');
  }

  // Extract task description (first positional arg, skipping flags)
  const taskDescription = getTaskDescriptionArg(args);
  if (!taskDescription) {
    throw new Error('Agent mode requires a task description as the first argument');
  }

  // Collect repeatable flags
  const contextPaths = collectRepeatable(args, '--context', '-c');
  const verifyCommands = collectRepeatable(args, '--verify', '-v');

  // Single-value flags
  const profile = getFlagValue(args, '--profile', '-p');
  const tier = (getFlagValue(args, '--tier', '-t') ?? 'standard') as 'standard' | 'premium';
  const outputPath = getFlagValue(args, '--output', '-o');
  const concurrency = parseInt(getFlagValue(args, '--concurrency') ?? '4', 10);
  const timeout = parseInt(getFlagValue(args, '--timeout') ?? '3600000', 10);

  // Boolean flags
  const dryRun = args.includes('--dry-run') || args.includes('-d');

  // Validate tier
  if (tier !== 'standard' && tier !== 'premium') {
    throw new Error(`Invalid tier "${tier}". Must be "standard" or "premium".`);
  }

  // Validate concurrency
  if (isNaN(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error(`Invalid concurrency "${concurrency}". Must be 1-32.`);
  }

  // Validate timeout
  if (isNaN(timeout) || timeout < 1000) {
    throw new Error(`Invalid timeout "${timeout}". Must be at least 1000ms.`);
  }

  return {
    taskDescription,
    agentRef,
    profile,
    tier,
    dryRun,
    contextPaths,
    verifyCommands,
    outputPath,
    concurrency,
    timeout,
  };
}
```

### Helper: `getTaskDescriptionArg(args: string[]): string | undefined`

Extracts the first positional argument that is not a flag and not a flag value. In agent mode, this is the task description (typically quoted).

```ts
function getTaskDescriptionArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (FLAGS_WITH_VALUES.has(arg)) i += 1; // skip value
      continue;
    }
    return arg;
  }
  return undefined;
}
```

> **Note:** This replaces the existing `getYamlPathArg` in the shared codepath. In YAML mode, the positional arg is a file path. In agent mode, it is a task description. The existing function can be reused since the logic is identical — only the semantic interpretation differs.

### Helper: `collectRepeatable(args: string[], long: string, short?: string): string[]`

Collects all values for a repeatable flag.

```ts
function collectRepeatable(args: string[], long: string, short?: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === long || (short && args[i] === short)) {
      const val = args[i + 1];
      if (val && !val.startsWith('-')) {
        values.push(val);
        i += 1;
      }
    }
  }
  return values;
}
```

### Helper: `getFlagValue(args: string[], long: string, short?: string): string | undefined`

Extracts a single flag value.

```ts
function getFlagValue(args: string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === long || (short && args[i] === short)) {
      const val = args[i + 1];
      if (val && !val.startsWith('-')) return val;
    }
  }
  return undefined;
}
```

---

## Default Context File Heuristics

### File: `packages/sdk/src/workflows/context-heuristics.ts`

When `--context` is not provided, the CLI infers context files based on the resolved intent. This provides a zero-config experience for common use cases.

```ts
import type { ContextFileSpec } from './persona-utils.js';

/**
 * Heuristic context file mappings per intent.
 * Each entry produces ContextFileSpec[] when the corresponding files exist on disk.
 */
export interface ContextHeuristic {
  /** Intent this heuristic applies to. */
  intent: string;
  /** Candidate file patterns to probe. */
  candidates: CandidateSpec[];
}

export interface CandidateSpec {
  /** Step name for the generated context step. */
  stepName: string;
  /** Glob pattern or literal path to check. */
  pattern: string;
  /** Shell command to capture the file. Defaults to `cat <matched-path>`. */
  command?: string;
  /** Priority when multiple candidates match (lower = higher priority). */
  priority: number;
  /** Max files to include from this pattern (default: 1). */
  maxFiles?: number;
}
```

### Intent-to-Context Mapping Table

| Intent                  | Candidates                                                                       | Rationale                                         |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| `review`                | `src/**/*.ts` (changed files via `git diff --name-only HEAD~1`), `tsconfig.json` | Review needs the changed files and project config |
| `security-review`       | `src/**/*.ts` (changed files), `package.json`, `.env.example`                    | Security needs dependency info and env patterns   |
| `architecture-plan`     | `tsconfig.json`, `package.json`, `src/**/index.ts`                               | Architecture needs entry points and config        |
| `requirements-analysis` | `README.md`, `docs/**/*.md`, `package.json`                                      | Requirements derive from existing docs            |
| `debugging`             | Test output via `npm test 2>&1 \| tail -50`, `src/**/*.test.ts` (failing tests)  | Debugging needs error output                      |
| `documentation`         | `README.md`, `src/**/index.ts`, `docs/**/*.md`                                   | Docs need existing docs and public API            |
| `verification`          | `.github/workflows/*.yml`, `package.json`, `tsconfig.json`                       | Verification checks CI and config                 |
| `test-strategy`         | `src/**/*.test.ts`, `jest.config.*`, `vitest.config.*`                           | Test strategy needs existing test structure       |
| `tdd-enforcement`       | `src/**/*.test.ts`, `src/**/*.ts` (paired source files)                          | TDD needs test-source pairs                       |
| `flake-investigation`   | CI logs via `gh run view --log-failed 2>&1 \| tail -100`, `src/**/*.test.ts`     | Flake investigation needs CI output               |
| `npm-provenance`        | `.github/workflows/publish.yml`, `package.json`, `.npmrc`                        | Provenance needs publish config                   |
| `implement-frontend`    | `src/**/*.tsx`, `src/**/*.css`, `package.json`                                   | Frontend needs UI files                           |
| `code-gen`              | `package.json`, `tsconfig.json`, `src/**/index.ts`                               | General code needs project structure              |

### `inferContextFiles(intent: string, cwd: string): Promise<ContextFileSpec[]>`

Probes the filesystem for candidate files and returns matching `ContextFileSpec[]`.

```ts
import { glob } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ContextFileSpec } from './persona-utils.js';

/**
 * Infer context files for a given intent by probing the filesystem.
 *
 * @param intent - Resolved intent string from persona resolution
 * @param cwd - Working directory to search from
 * @returns Context file specs for files that exist on disk
 */
export async function inferContextFiles(intent: string, cwd: string): Promise<ContextFileSpec[]> {
  const heuristic = CONTEXT_HEURISTICS.find((h) => h.intent === intent.toLowerCase().trim());

  if (!heuristic) {
    // Fallback: read package.json and tsconfig.json if they exist
    return inferFallbackContext(cwd);
  }

  const results: ContextFileSpec[] = [];

  for (const candidate of heuristic.candidates) {
    const matched = await probeCandidate(candidate, cwd);
    results.push(...matched);
  }

  // Cap total context files at 10 to avoid overwhelming the agent
  return results.slice(0, 10);
}
```

### `probeCandidate(candidate: CandidateSpec, cwd: string): Promise<ContextFileSpec[]>`

```ts
async function probeCandidate(candidate: CandidateSpec, cwd: string): Promise<ContextFileSpec[]> {
  const maxFiles = candidate.maxFiles ?? 1;

  // If the pattern is a shell command (starts with a known command prefix), use it directly
  if (
    candidate.pattern.startsWith('git ') ||
    candidate.pattern.startsWith('npm ') ||
    candidate.pattern.startsWith('gh ') ||
    candidate.pattern.startsWith('cat ')
  ) {
    return [
      {
        stepName: candidate.stepName,
        command: candidate.command ?? candidate.pattern,
      },
    ];
  }

  // If the pattern is a literal path, check existence
  if (!candidate.pattern.includes('*') && !candidate.pattern.includes('{')) {
    const fullPath = path.join(cwd, candidate.pattern);
    if (existsSync(fullPath)) {
      return [
        {
          stepName: candidate.stepName,
          command: candidate.command ?? `cat ${candidate.pattern}`,
        },
      ];
    }
    return [];
  }

  // Glob expansion
  const matches = await globFiles(candidate.pattern, cwd);
  return matches.slice(0, maxFiles).map((filePath, idx) => ({
    stepName: maxFiles > 1 ? `${candidate.stepName}-${idx}` : candidate.stepName,
    command: candidate.command ?? `cat ${filePath}`,
  }));
}
```

### `inferFallbackContext(cwd: string): Promise<ContextFileSpec[]>`

```ts
async function inferFallbackContext(cwd: string): Promise<ContextFileSpec[]> {
  const fallbackFiles = ['package.json', 'tsconfig.json', 'README.md'];
  const results: ContextFileSpec[] = [];

  for (const file of fallbackFiles) {
    if (existsSync(path.join(cwd, file))) {
      results.push({
        stepName: `read-${file.replace(/\./g, '-')}`,
        command: `cat ${file}`,
      });
    }
  }

  return results;
}
```

---

## ResolvePersonaByIdOrIntent Integration

### `buildWorkflowInput(flags: AgentModeFlags, cwd: string): Promise<WorkflowGeneratorInput>`

Bridges CLI flags to the `WorkflowGeneratorInput` expected by the Phase 2 generator.

```ts
import {
  resolvePersonaByIdOrIntent,
  type PersonaProfile,
  type PersonaResolution,
  type WorkflowGeneratorInput,
  type ContextFileSpec,
  type VerificationSpec,
} from './persona-utils.js';
import { inferContextFiles } from './context-heuristics.js';

/**
 * Build a WorkflowGeneratorInput from parsed CLI flags.
 *
 * 1. Resolve persona via resolvePersonaByIdOrIntent()
 * 2. Determine context files (explicit --context or heuristic inference)
 * 3. Map --verify commands to VerificationSpec[]
 * 4. Assemble the complete input
 */
export async function buildWorkflowInput(
  flags: AgentModeFlags,
  cwd: string
): Promise<WorkflowGeneratorInput> {
  // Step 1: Resolve persona
  const profileHint: PersonaProfile | undefined = flags.profile
    ? { id: flags.profile, name: flags.profile }
    : undefined;

  const selection: PersonaResolution = resolvePersonaByIdOrIntent(flags.agentRef, profileHint);

  // Step 2: Determine context files
  let contextFiles: ContextFileSpec[];
  if (flags.contextPaths.length > 0) {
    // Explicit context: each --context path becomes a context file spec
    contextFiles = flags.contextPaths.map((filePath, idx) => ({
      stepName: `read-context-${idx}`,
      command: `cat ${filePath}`,
    }));
  } else {
    // Heuristic inference based on intent
    contextFiles = await inferContextFiles(selection.intent, cwd);
  }

  // Step 3: Map --verify commands to VerificationSpec[]
  const verifications: VerificationSpec[] = flags.verifyCommands.map((cmd, idx) => ({
    stepName: `verify-${idx}`,
    command: cmd,
  }));

  // Step 4: Assemble workflow name
  const workflowName = slugify(flags.taskDescription);

  // Step 5: Build complete input
  return {
    taskDescription: flags.taskDescription,
    workflowName,
    persona: selection.persona ?? {
      id: selection.intent,
      name: selection.intent,
      intent: selection.intent,
      preset: selection.preset,
      pattern: selection.pattern,
    },
    selection,
    skillPlan: { installs: [] }, // Skills are resolved in a future phase
    contextFiles,
    verifications,
    outputFile: flags.outputPath,
    maxConcurrency: flags.concurrency,
    timeout: flags.timeout,
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
```

---

## Agent Mode Execution Flow

### Updated `main()` in `cli.ts`

The following shows the agent-mode branch inserted into the existing `main()` function. The YAML-mode codepath is unchanged.

```ts
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    printUsage();
    process.exit(args.includes('--help') ? 0 : 1);
  }

  // ── Agent mode ────────────────────────────────────────────────────────────
  const agentFlags = parseAgentFlags(args);
  if (agentFlags) {
    await runAgentMode(agentFlags);
    return;
  }

  // ── Resume mode (unchanged) ───────────────────────────────────────────────
  // ... existing resume code ...

  // ── Normal / validate / dry-run mode (unchanged) ──────────────────────────
  // ... existing YAML code ...
}
```

### `runAgentMode(flags: AgentModeFlags): Promise<void>`

```ts
import { generateWorkflow } from './workflow-generator.js';
import { writeFile } from 'node:fs/promises';

async function runAgentMode(flags: AgentModeFlags): Promise<void> {
  const cwd = process.cwd();

  // Step 1: Build workflow input from CLI flags
  console.log(chalk.dim(`Resolving persona: ${flags.agentRef}...`));
  const input = await buildWorkflowInput(flags, cwd);

  // Step 2: Log resolution result
  const resLabel = input.selection.resolved
    ? chalk.green(`resolved → ${input.selection.intent}`)
    : chalk.yellow(`derived → ${input.selection.intent}`);
  console.log(
    chalk.dim('Persona:'),
    resLabel,
    chalk.dim(`(preset: ${input.selection.preset}, pattern: ${input.selection.pattern})`)
  );
  console.log(
    chalk.dim(`Context files: ${input.contextFiles.length}`),
    chalk.dim(`| Verifications: ${input.verifications.length}`)
  );

  // Step 3: Generate workflow
  const generated = generateWorkflow(input);

  // Step 4: Handle --output (write generated source to file)
  if (flags.outputPath) {
    await writeFile(flags.outputPath, generated.source, 'utf-8');
    console.log(chalk.dim(`Generated workflow written to: ${flags.outputPath}`));
  }

  // Step 5: Handle --dry-run
  if (flags.dryRun) {
    printDryRunReport(generated, input);
    process.exit(0);
  }

  // Step 6: Execute the generated workflow
  console.log(chalk.dim(`\nExecuting workflow: ${input.workflowName}...`));

  // Write generated source to a temp file for WorkflowRunner
  const tmpPath = path.join(cwd, '.agent-relay', `_agent-${input.workflowName}.ts`);
  await writeFile(tmpPath, generated.source, 'utf-8');

  // Use the standard WorkflowRunner execution path
  const dbPath = path.join(cwd, '.agent-relay', 'workflow-runs.jsonl');
  const fileDb = new JsonFileWorkflowDb(dbPath);
  const runner = new WorkflowRunner({ db: fileDb });

  // Install shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[workflow] ${signal} received — shutting down broker...`);
    await runner.relay?.shutdown().catch(() => undefined);
    process.exit(130);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Parse the generated file as a workflow config and execute
  const config = await runner.parseYamlFile(tmpPath);
  const result = await runWithListr(runner, config, undefined, undefined);

  if (result.status === 'completed') {
    console.log(chalk.green('\nWorkflow completed successfully.'));
    process.exit(0);
  } else {
    console.error(chalk.red(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`));
    process.exit(1);
  }
}
```

### `printDryRunReport(generated: GeneratedWorkflow, input: WorkflowGeneratorInput): void`

```ts
function printDryRunReport(generated: GeneratedWorkflow, input: WorkflowGeneratorInput): void {
  const { metadata } = generated;

  console.log('\n' + chalk.bold('=== Dry Run Report ==='));
  console.log(chalk.dim('Workflow:    '), metadata.name);
  console.log(chalk.dim('Pattern:     '), metadata.pattern);
  console.log(chalk.dim('Preset:      '), metadata.preset);
  console.log(chalk.dim('Agents:      '), metadata.agentCount);
  console.log(chalk.dim('Total steps: '), metadata.stepCount);
  console.log(chalk.dim('Est. waves:  '), metadata.estimatedWaves);
  console.log(chalk.dim('Concurrency: '), input.maxConcurrency);
  console.log(chalk.dim('Timeout:     '), `${input.timeout}ms`);

  console.log('\n' + chalk.bold('Phases:'));
  console.log(chalk.dim('  Skills:       '), metadata.phases.skills || 'none');
  console.log(chalk.dim('  Context:      '), metadata.phases.context || 'none');
  console.log(chalk.dim('  Task:         '), metadata.phases.task);
  console.log(chalk.dim('  Verification: '), metadata.phases.verification || 'none');

  if (input.contextFiles.length > 0) {
    console.log('\n' + chalk.bold('Context files:'));
    for (const ctx of input.contextFiles) {
      console.log(chalk.dim(`  ${ctx.stepName}: `) + ctx.command);
    }
  }

  if (input.verifications.length > 0) {
    console.log('\n' + chalk.bold('Verifications:'));
    for (const ver of input.verifications) {
      console.log(chalk.dim(`  ${ver.stepName}: `) + ver.command);
    }
  }

  if (input.outputFile) {
    console.log('\n' + chalk.dim('Output: ') + input.outputFile);
  }

  console.log('\n' + chalk.bold('Generated source:'));
  console.log(chalk.dim('─'.repeat(72)));
  console.log(generated.source);
  console.log(chalk.dim('─'.repeat(72)));
}
```

---

## Mutual Exclusivity Validation

Agent mode flags must not be combined with YAML mode flags. Add validation at the top of `runAgentMode()`:

```ts
function validateFlagExclusivity(args: string[]): void {
  const yamlOnlyFlags = ['--resume', '--workflow', '--start-from', '--previous-run-id', '--validate'];
  const agentOnlyFlags = ['--agent', '-a', '--profile', '-p', '--tier', '-t', '--verify', '-v'];

  const hasAgent = args.some((a) => a === '--agent' || a === '-a');
  if (!hasAgent) return;

  for (const flag of yamlOnlyFlags) {
    if (args.includes(flag)) {
      throw new Error(
        `"${flag}" cannot be used with --agent. ` + `Use either YAML mode or agent mode, not both.`
      );
    }
  }
}
```

---

## File Structure Changes

### `packages/sdk/src/workflows/cli.ts` — Modifications

```
cli.ts (modified)
  ├── Updated FLAGS_WITH_VALUES (add agent-mode flags)
  ├── Updated printUsage() (add agent-mode docs)
  ├── New: parseAgentFlags()
  ├── New: getTaskDescriptionArg() (replaces getYamlPathArg in shared logic)
  ├── New: collectRepeatable()
  ├── New: getFlagValue()
  ├── New: validateFlagExclusivity()
  ├── New: buildWorkflowInput()
  ├── New: runAgentMode()
  ├── New: printDryRunReport()
  ├── Modified: main() (insert agent-mode branch before resume-mode)
  └── New imports: persona-utils, workflow-generator, context-heuristics
```

### `packages/sdk/src/workflows/context-heuristics.ts` — New File

```
context-heuristics.ts (new)
  ├── Interface definitions (ContextHeuristic, CandidateSpec)
  ├── CONTEXT_HEURISTICS constant (intent-to-candidate mapping)
  ├── inferContextFiles()
  ├── probeCandidate()
  ├── inferFallbackContext()
  └── globFiles() helper
```

### Imports Added to `cli.ts`

```ts
import {
  resolvePersonaByIdOrIntent,
  type PersonaProfile,
  type PersonaResolution,
  type WorkflowGeneratorInput,
  type ContextFileSpec,
  type VerificationSpec,
} from './persona-utils.js';
import { generateWorkflow, type GeneratedWorkflow } from './workflow-generator.js';
import { inferContextFiles } from './context-heuristics.js';
import { writeFile } from 'node:fs/promises';
```

---

## SDK Export Changes

Add to `packages/sdk/src/workflows/index.ts`:

```ts
export { inferContextFiles, type ContextHeuristic, type CandidateSpec } from './context-heuristics.js';

export { parseAgentFlags, buildWorkflowInput, type AgentModeFlags } from './cli.js';
```

---

## File: `packages/sdk/src/workflows/__tests__/context-heuristics.test.ts`

### Test Structure (vitest)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inferContextFiles } from '../context-heuristics.js';
```

### Test Cases

#### `inferContextFiles`

| Test                                   | Setup                           | Input                                            | Assertions                                   |
| -------------------------------------- | ------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Returns fallback when intent unknown   | Create `package.json` in tmpdir | `inferContextFiles('unknown-intent', tmpdir)`    | Returns spec for `package.json`              |
| Returns empty when no files match      | Empty tmpdir                    | `inferContextFiles('review', tmpdir)`            | `result.length === 0`                        |
| Finds tsconfig for architecture-plan   | Create `tsconfig.json`          | `inferContextFiles('architecture-plan', tmpdir)` | Result includes `read-tsconfig-json` step    |
| Finds package.json for security-review | Create `package.json`           | `inferContextFiles('security-review', tmpdir)`   | Result includes step with `cat package.json` |
| Finds README for documentation         | Create `README.md`              | `inferContextFiles('documentation', tmpdir)`     | Result includes step with `cat README.md`    |
| Caps at 10 context files               | Create 15 matching files        | `inferContextFiles('review', tmpdir)`            | `result.length <= 10`                        |
| Case-insensitive intent matching       | Create `package.json`           | `inferContextFiles('SECURITY-REVIEW', tmpdir)`   | Same as lowercase                            |
| Uses git diff for review intent        | Has git repo                    | `inferContextFiles('review', tmpdir)`            | Step command includes `git diff`             |

---

## End-to-End Flow Example

### Command

```bash
relay-workflow "Review the auth middleware for OWASP vulnerabilities" \
  --agent security-review \
  --context src/middleware/auth.ts \
  --context src/middleware/auth.test.ts \
  --verify "! grep -r 'eval(' src/middleware/" \
  --output reports/security-workflow.ts
```

### Execution Steps

1. **Parse flags:**

   ```
   taskDescription: "Review the auth middleware for OWASP vulnerabilities"
   agentRef: "security-review"
   contextPaths: ["src/middleware/auth.ts", "src/middleware/auth.test.ts"]
   verifyCommands: ["! grep -r 'eval(' src/middleware/"]
   outputPath: "reports/security-workflow.ts"
   dryRun: false, concurrency: 4, timeout: 3600000
   ```

2. **Resolve persona:**

   ```
   resolvePersonaByIdOrIntent("security-review")
   → { resolved: true, intent: "security-review", preset: "analyst", pattern: "dag",
        persona: { id: "security-reviewer-v1", name: "Security Reviewer" } }
   ```

3. **Build context files (explicit):**

   ```
   [
     { stepName: "read-context-0", command: "cat src/middleware/auth.ts" },
     { stepName: "read-context-1", command: "cat src/middleware/auth.test.ts" },
   ]
   ```

4. **Build verifications:**

   ```
   [
     { stepName: "verify-0", command: "! grep -r 'eval(' src/middleware/" },
   ]
   ```

5. **Generate workflow** via `generateWorkflow(input)`

6. **Write to `reports/security-workflow.ts`**

7. **Execute** via `WorkflowRunner`

### Dry-Run Example

```bash
relay-workflow "Write API docs for the SDK" --agent documentation --dry-run
```

Output:

```
Resolving persona: documentation...
Persona: resolved → documentation (preset: worker, pattern: pipeline)
Context files: 3 | Verifications: 0

=== Dry Run Report ===
Workflow:     write-api-docs-for-the-sdk
Pattern:      pipeline
Preset:       worker
Agents:       1
Total steps:  7
Est. waves:   6
Concurrency:  4
Timeout:      3600000ms

Phases:
  Skills:        none
  Context:       3
  Task:          3
  Verification:  none

Context files:
  read-readme: cat README.md
  read-index-0: cat src/index.ts
  read-docs-0: cat docs/getting-started.md

Generated source:
────────────────────────────────────────────────────────────────────────
/**
 * Auto-generated workflow: write-api-docs-for-the-sdk
 * Persona: Documentation Writer (documentation)
 * Pattern: pipeline | Preset: worker
 * Generated: 2026-04-10T12:00:00.000Z
 */
import { workflow } from '@agent-relay/sdk/workflows';
...
────────────────────────────────────────────────────────────────────────
```

---

## Implementation Notes

1. **Backward compatible.** The `--agent` flag is entirely opt-in. Without it, the CLI behaves exactly as before. No existing flags or behaviors are changed.

2. **Positional argument reuse.** Both YAML mode and agent mode use the first positional argument — a file path in YAML mode, a task description in agent mode. The `getYamlPathArg` helper is reused via `getTaskDescriptionArg` (identical logic, different semantics).

3. **Context heuristics are best-effort.** `inferContextFiles()` probes the filesystem and returns only files that exist. If no heuristic matches the intent, it falls back to common project files (`package.json`, `tsconfig.json`, `README.md`). The 10-file cap prevents overwhelming the agent with context.

4. **Generated workflow is ephemeral.** The workflow is written to `.agent-relay/_agent-{name}.ts` for execution and can be cleaned up later. The `--output` flag provides a way to persist the generated source at a user-chosen location.

5. **No new npm dependencies.** All new code uses Node.js built-ins (`fs`, `path`), existing SDK types from Phase 1/2, and `chalk` (already a dependency). The `glob` function uses the Node.js 22+ built-in `fs.glob` or falls back to `globby` if available.

6. **Tier flag is forward-looking.** The `--tier` flag is parsed and validated but not consumed by the workflow generator in this phase. It will be used in a future phase to select model tiers (e.g., `claude-sonnet` for standard, `claude-opus` for premium).

7. **Validation is fail-fast.** Invalid flag combinations, missing required values, and out-of-range numbers all throw synchronous errors before any async work begins.

8. **Pattern follows existing CLI conventions.** The flag parsing uses the same manual `args` iteration pattern as the existing CLI code (no external argument parser). This maintains consistency and avoids adding dependencies like `yargs` or `commander`.

---

## Acceptance Criteria

- [ ] `--agent` / `-a` flag activates agent mode; without it, existing YAML mode is unchanged
- [ ] `parseAgentFlags()` correctly extracts all flags including repeatable `--context` and `--verify`
- [ ] `buildWorkflowInput()` calls `resolvePersonaByIdOrIntent()` and produces a valid `WorkflowGeneratorInput`
- [ ] Explicit `--context` paths override heuristic inference
- [ ] `inferContextFiles()` returns appropriate context for all 13 intents when files exist
- [ ] `inferContextFiles()` falls back to common files for unknown intents
- [ ] `--dry-run` prints the generated workflow source and metadata without executing
- [ ] `--output` writes the generated workflow to the specified path
- [ ] `--concurrency` and `--timeout` are forwarded to `WorkflowGeneratorInput`
- [ ] `--tier` is parsed and validated (`'standard'` | `'premium'`)
- [ ] `--profile` is passed as a disambiguation hint to `resolvePersonaByIdOrIntent()`
- [ ] Agent-mode flags and YAML-mode flags are mutually exclusive (error on mix)
- [ ] Short flags (`-a`, `-p`, `-t`, `-d`, `-c`, `-v`, `-o`) work correctly
- [ ] Invalid flag values produce clear error messages (not stack traces)
- [ ] Context file heuristics cap at 10 files
- [ ] Generated workflow executes successfully via `WorkflowRunner`
- [ ] All tests pass via `vitest`
- [ ] No new external npm dependencies introduced
- [ ] Updated `--help` output documents all new flags with examples
