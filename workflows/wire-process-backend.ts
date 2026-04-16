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
 * 3. Store it on the runner with a TODO for the broker-side integration.
 *
 * The Rust broker change (replacing Command::spawn with backend.exec)
 * is a separate follow-up. This TS adapter is the bridge.
 */
import { workflow } from '@agent-relay/sdk/workflows';

const CHANNEL = 'wf-wire-process-backend';

async function main() {
  const result = await workflow('wire-process-backend')
    .description(
      'Wire ProcessBackend into the SDK runner so cloud sandboxes go through the broker',
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
// Relay owns agent configuration (MCP wiring, CLI flags, auth env, lifecycle).
// Cloud owns execution environment (create VM, run command, destroy VM).
// The broker builds a fully-configured command and calls env.exec().

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
   * When set, the runner creates isolated environments via this backend
   * for each agent step. The broker still handles agent configuration
   * (MCP wiring, CLI flags, auth env). The backend only provides
   * "where to run" — create environment, execute command, destroy.
   *
   * When both executor and processBackend are set, executor takes precedence.
   * When neither is set, the broker spawns local child processes (default).
   */
  processBackend?: ProcessBackend;

Make sure to import ProcessBackend from the types file at the top of runner.ts.

### 3. Store processBackend in constructor

In the constructor, after the line that sets this.executor, add:

    this.processBackend = options.processBackend;

And add the private field to the class:

  private readonly processBackend?: ProcessBackend;

### 4. DO NOT change the executor fork or requiresBroker

Add a TODO comment near the fork at ~line 4038:

  // TODO(process-backend): When processBackend is set, the broker should
  // use it to create environments for agent processes instead of local
  // Command::spawn(). This requires the broker's WorkerRegistry to accept
  // a process backend. Until then, processBackend is stored but unused
  // at runtime — the cloud still uses the executor path via RunnerStepExecutor.

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
        'if git diff --quiet packages/sdk/src/workflows/types.ts; then echo "types.ts NOT MODIFIED"; exit 1; fi',
        'if git diff --quiet packages/sdk/src/workflows/runner.ts; then echo "runner.ts NOT MODIFIED"; exit 1; fi',
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
      command: 'git add packages/sdk/src/workflows/types.ts packages/sdk/src/workflows/runner.ts && git diff --cached --quiet && echo "NO CHANGES" && exit 1; git commit -m "feat(sdk): add ProcessBackend interface and accept in WorkflowRunnerOptions" && git push origin feat/process-backend-runner',
      captureOutput: true,
      failOnError: true,
    })

    .step('open-pr', {
      type: 'deterministic',
      dependsOn: ['commit'],
      command: [
        "gh pr view feat/process-backend-runner --repo AgentWorkforce/relay --json url -q .url 2>/dev/null && echo 'PR already exists' && exit 0",
        "gh pr create --repo AgentWorkforce/relay --base main --head feat/process-backend-runner --title 'feat(sdk): add ProcessBackend interface for cloud sandbox execution' --body \"## Summary\n\nAdds ProcessBackend and ProcessEnvironment interfaces to the SDK and accepts\nprocessBackend in WorkflowRunnerOptions. This is the relay-side counterpart\nto AgentWorkforce/cloud#115.\n\n## What this does\n\n- Exports ProcessBackend + ProcessEnvironment from @agent-relay/sdk/workflows\n- WorkflowRunnerOptions accepts optional processBackend field\n- Runner stores the backend (ready for broker integration)\n\n## What this does NOT do (yet)\n\n- Does not change the this.executor fork at runner.ts:4038\n- Does not wire the broker to use the backend for spawning\n- Those require broker-side changes (Rust WorkerRegistry)\n\n## Test plan\n\n- [x] npm run build passes\n- [x] npm test passes\"",
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
