/**
 * wire-process-backend — Wire ProcessBackend into the SDK runner
 * ================================================================
 *
 * Run:
 *   agent-relay run workflows/wire-process-backend.ts
 *
 * Resume from a specific step (reuses cached outputs from the last run):
 *   START_FROM=build agent-relay run workflows/wire-process-backend.ts
 *   START_FROM=commit agent-relay run workflows/wire-process-backend.ts
 *
 * Resume a specific failed run by ID:
 *   RESUME_RUN_ID=<run-id> agent-relay run workflows/wire-process-backend.ts
 *
 * ────────────────────────────────────────────────────────────────────
 *
 * The cloud repo now exports a ProcessBackend interface:
 *
 *   interface ProcessBackend {
 *     createEnvironment(label): Promise<ProcessEnvironment>
 *   }
 *   interface ProcessEnvironment {
 *     id: string; homeDir: string;
 *     exec(command, opts?): Promise<{ output, exitCode }>
 *     uploadFile(content, path): Promise<void>
 *     destroy(): Promise<void>
 *   }
 *
 * This workflow wires it into the relay SDK so the runner can use it:
 *
 * 1. Add ProcessBackend + ProcessEnvironment interfaces to the SDK
 *    (packages/sdk/src/workflows/types.ts)
 *
 * 2. Accept processBackend in WorkflowRunnerOptions
 *    (packages/sdk/src/workflows/runner.ts)
 *
 * 3. Create a ProcessBackend-backed RunnerStepExecutor when processBackend is
 *    set and no explicit executor is provided.
 *
 * The Rust broker change (replacing Command::spawn with backend.exec) remains
 * a separate follow-up. This TS adapter lets workflow steps run in cloud
 * environments without changing the default local broker path.
 */
import { workflow } from '@agent-relay/sdk/workflows';

const CHANNEL = 'wf-wire-process-backend';
const FEATURE_BRANCH = 'feat/process-backend-runner';

async function main() {
  const result = await workflow('wire-process-backend')
    .description(
      'Wire ProcessBackend into the SDK runner so cloud sandboxes can execute workflow steps',
    )
    .pattern('dag')
    .channel(CHANNEL)
    .maxConcurrency(3)
    .timeout(1_200_000)

    .agent('impl', {
      cli: 'claude',
      role: 'Implements the ProcessBackend wiring in the relay SDK',
      retries: 2,
    })

    // ── Phase 1: Read ────────────────────────────────────────────────
    .step('read-types', {
      type: 'deterministic',
      command: 'cat packages/sdk/src/workflows/types.ts',
      captureOutput: true,
    })

    .step('read-runner-options', {
      type: 'deterministic',
      command: 'sed -n "250,290p" packages/sdk/src/workflows/runner.ts',
      captureOutput: true,
    })

    .step('read-runner-constructor', {
      type: 'deterministic',
      command: 'sed -n "460,470p" packages/sdk/src/workflows/runner.ts',
      captureOutput: true,
    })

    .step('read-runner-fork', {
      type: 'deterministic',
      command: 'sed -n "4033,4055p" packages/sdk/src/workflows/runner.ts',
      captureOutput: true,
    })

    .step('read-requires-broker', {
      type: 'deterministic',
      command: 'sed -n "2710,2730p" packages/sdk/src/workflows/runner.ts',
      captureOutput: true,
    })

    .step('read-build-command', {
      type: 'deterministic',
      command: 'grep -n "buildNonInteractiveCommand" packages/sdk/src/workflows/runner.ts | head -10',
      captureOutput: true,
    })

    .step('read-exports', {
      type: 'deterministic',
      command: 'grep -n "export" packages/sdk/src/workflows/index.ts 2>/dev/null || echo "no index.ts barrel"',
      captureOutput: true,
    })

    .step('read-tests', {
      type: 'deterministic',
      command: 'ls packages/sdk/src/workflows/__tests__/*.test.ts 2>/dev/null | head -10 && echo "---" && cat packages/sdk/src/workflows/__tests__/step-executor.test.ts 2>/dev/null | head -50 || echo "no step-executor test"',
      captureOutput: true,
    })

    // ── Phase 2: Implement ───────────────────────────────────────────
    .step('implement', {
      agent: 'impl',
      dependsOn: [
        'read-types', 'read-runner-options', 'read-runner-constructor',
        'read-runner-fork', 'read-requires-broker', 'read-build-command',
        'read-exports', 'read-tests',
      ],
      task: `Wire ProcessBackend into the relay SDK runner. This is a BACKWARD COMPATIBLE change — when no processBackend is provided, behavior is identical to today.

## Current code

=== packages/sdk/src/workflows/types.ts (excerpt) ===
{{steps.read-types.output}}

=== WorkflowRunnerOptions + RunnerStepExecutor (runner.ts:250-290) ===
{{steps.read-runner-options.output}}

=== Constructor (runner.ts:460-470) ===
{{steps.read-runner-constructor.output}}

=== The fork (runner.ts:4033-4055) ===
{{steps.read-runner-fork.output}}

=== requiresBroker check (runner.ts:2710-2730) ===
{{steps.read-requires-broker.output}}

=== buildNonInteractiveCommand references ===
{{steps.read-build-command.output}}

=== Exports ===
{{steps.read-exports.output}}

=== Tests ===
{{steps.read-tests.output}}

## Changes needed

### 1. Add ProcessBackend interfaces to types.ts

At the end of packages/sdk/src/workflows/types.ts, add:

// ── ProcessBackend: cloud-injected execution environment ─────────────────────
//
// Relay owns command construction, auth env, cwd, timeout, and step lifecycle.
// The backend owns execution environments (create VM, run command, destroy VM).
// uploadFile is reserved for future file asset staging; current executors run
// commands directly with env/cwd/timeout passed through exec options.

export interface ProcessBackend {
  /** Create an isolated execution environment (e.g. a Daytona sandbox). */
  createEnvironment(label: string): Promise<ProcessEnvironment>;
}

export interface ProcessEnvironment {
  /** Unique identifier for this environment. */
  id: string;
  /** Home directory inside the environment. */
  homeDir: string;
  /** Execute a shell command in the environment. */
  exec(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }): Promise<{ output: string; exitCode: number }>;
  /** Upload a file into the environment. */
  uploadFile(content: string | Buffer, remotePath: string): Promise<void>;
  /** Tear down the environment and release resources. */
  destroy(): Promise<void>;
}

### 2. Add processBackend to WorkflowRunnerOptions

In packages/sdk/src/workflows/runner.ts, find the WorkflowRunnerOptions interface and add:

  /**
   * Process backend for remote execution environments.
   * When set without an explicit executor, the runner wraps it in a
   * RunnerStepExecutor that creates isolated environments for agent and
   * deterministic steps. The runner builds CLI commands and passes auth env,
   * cwd, and timeout; the backend provides create/exec/destroy primitives.
   *
   * When both executor and processBackend are set, executor takes precedence.
   * When neither is set, the broker spawns local child processes (default).
   */
  processBackend?: ProcessBackend;

Make sure to import ProcessBackend from the types file at the top of runner.ts.

### 3. Store processBackend and synthesize an executor in the constructor

In the constructor, after the line that sets this.executor, add:

    this.processBackend = options.processBackend;

And add the private field to the class:

  private readonly processBackend?: ProcessBackend;

Then synthesize the ProcessBackend executor only when no explicit executor was
provided:

    if (!this.executor && this.processBackend) {
      this.executor = createProcessBackendExecutor(this.processBackend, {
        env: this.envSecrets,
      });
    }

### 4. Add the ProcessBackend executor

Add packages/sdk/src/workflows/process-backend-executor.ts. It should:

- Build non-interactive CLI commands using the existing process-spawner helper.
- Pass env, cwd, and ceil-rounded timeoutSeconds via ProcessEnvironment.exec options.
- Shell-escape argv safely before joining into the command string.
- Reject cli:"api" because API agents do not run as subprocesses.
- Destroy the environment in a finally block.

### 5. Keep the existing executor fork behavior

Do not add a second processBackend-specific fork. The constructor makes
this.executor point at the ProcessBackend executor when processBackend is set
and executor is omitted, so the existing this.executor branch remains the single
extension point. The default no-executor path still uses spawnAndWait.

After making changes, run:
  npm run build 2>&1 | tail -20
  npm test 2>&1 | tail -30

IMPORTANT: Write all changes to disk. Do NOT just output code.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 2b: Verify edits ───────────────────────────────────────
    .step('verify-edits', {
      type: 'deterministic',
      dependsOn: ['implement'],
      command: [
        'set -e',
        'grep -q "ProcessBackend" packages/sdk/src/workflows/types.ts || (echo "MISSING: ProcessBackend in types.ts"; exit 1)',
        'grep -q "ProcessEnvironment" packages/sdk/src/workflows/types.ts || (echo "MISSING: ProcessEnvironment in types.ts"; exit 1)',
        'grep -q "processBackend" packages/sdk/src/workflows/runner.ts || (echo "MISSING: processBackend in runner.ts"; exit 1)',
        'grep -q "createProcessBackendExecutor" packages/sdk/src/workflows/process-backend-executor.ts || (echo "MISSING: ProcessBackend executor"; exit 1)',
        'if git diff --quiet packages/sdk/src/workflows/types.ts; then echo "types.ts NOT MODIFIED"; exit 1; fi',
        'if git diff --quiet packages/sdk/src/workflows/runner.ts; then echo "runner.ts NOT MODIFIED"; exit 1; fi',
        'if git diff --quiet packages/sdk/src/workflows/process-backend-executor.ts; then echo "process-backend-executor.ts NOT MODIFIED"; exit 1; fi',
        'echo "All expected changes verified"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 3: Build + test gate ──────────────────────────────────
    .step('build', {
      type: 'deterministic',
      dependsOn: ['verify-edits'],
      command: 'npm run build 2>&1 | tail -30',
      captureOutput: true,
      failOnError: true,
    })

    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['verify-edits'],
      command: 'npm test 2>&1 | tail -60',
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 4: Commit + push + PR ─────────────────────────────────
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['build', 'run-tests'],
      command: [
        `git checkout -B ${FEATURE_BRANCH}`,
        'git add packages/sdk/src/workflows/types.ts packages/sdk/src/workflows/runner.ts packages/sdk/src/workflows/process-backend-executor.ts packages/sdk/src/workflows/index.ts packages/sdk/src/workflows/__tests__/process-backend-executor.test.ts workflows/wire-process-backend.ts',
        'if git diff --cached --quiet; then echo "NO CHANGES"; exit 1; fi',
        'git commit -m "feat(sdk): add ProcessBackend executor for workflows"',
        `git push -u origin ${FEATURE_BRANCH}`,
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('open-pr', {
      type: 'deterministic',
      dependsOn: ['commit'],
      command: [
        `gh pr view ${FEATURE_BRANCH} --repo AgentWorkforce/relay --json url -q .url 2>/dev/null && echo 'PR already exists' && exit 0`,
        `gh pr create --repo AgentWorkforce/relay --base main --head ${FEATURE_BRANCH} --title 'feat(sdk): add ProcessBackend executor for cloud sandbox execution' --body "## Summary\n\nAdds ProcessBackend and ProcessEnvironment interfaces to the SDK, accepts processBackend in WorkflowRunnerOptions, and creates a ProcessBackend-backed RunnerStepExecutor when no explicit executor is provided.\n\n## What this does\n\n- Exports ProcessBackend + ProcessEnvironment from @agent-relay/sdk/workflows\n- WorkflowRunnerOptions accepts optional processBackend field\n- Agent and deterministic steps can execute through ProcessEnvironment.exec\n- env, cwd, and timeoutSeconds are passed through structured exec options\n\n## Boundary\n\n- Relay builds CLI commands and passes auth env, cwd, and timeout metadata\n- ProcessBackend creates environments, executes commands, and destroys environments\n- uploadFile is part of the interface for future file asset staging and is not used by this executor yet\n\n## Test plan\n\n- [x] npm run build passes\n- [x] npm test passes"`,
      ].join(' || '),
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log(`Run status: ${result.status}`);
  if (result.status !== 'completed') {
    process.exit(1);
  }
}

main().catch(console.error);
