# Workflow System Improvements Spec

**Date:** 2026-02-22
**Status:** Proposed
**Informed by:** `dashboard-pure-ui-refactor` workflow (23-step, 5-agent DAG)

---

## Background

A 23-step, 5-agent DAG workflow (`dashboard-pure-ui-refactor`) was designed and executed to refactor a dashboard application into a pure UI kit. The workflow used the following agents:

- **lead** -- orchestrated reviews and final approval
- **reviewer** -- code review and verification
- **dashboard-worker** -- refactored the relay-dashboard repo
- **cloud-worker** -- updated the relay-cloud repo to consume the new UI kit
- **local-worker** -- updated the relay-cli repo

The workflow touched three repositories: `relay-dashboard`, `relay-cloud`, and `relay-cli`. The DAG pattern allowed parallel execution of independent refactoring tasks across repos, with review gates between phases.

Once operational bugs in the PTY broker were identified and fixed (see "Operational Bugs Fixed" section below), the workflow ran cleanly in approximately 1 hour 27 minutes, with only a single retry needed due to a verification flake. However, reaching that clean run required approximately 8 hours of debugging across multiple attempts, revealing significant gaps in the workflow system's observability, resilience, and developer experience.

Three PTY broker bugs were discovered and fixed during this process:
1. `shutdown()` blocking forever on `child.wait()` after a child was already reaped
2. Init broker `reap_exited()` unable to detect dead PTY workers
3. `has_exited()` failing when portable-pty returned no PID

---

## Raw Feedback

> **1. Cross-repo write access**
> The biggest functional gap: the cloud agent couldn't write to `../relay-cloud` and had to produce a patch file instead. The workflow should support declaring which repos an agent can access, and the broker should set up the working directories accordingly.
>
> ```yaml
> agents:
>   cloud-worker:
>     cli: codex
>     cwd: ../relay-cloud
>     additionalPaths:
>       - ../relay-dashboard
> ```
>
> **2. Dry-run validation (the plan already exists)**
> We had a 23-step DAG and no way to validate it without running it. `agent-relay run workflow.yaml --dry-run` should show waves, agent assignments, dependency graph, and catch issues like missing deps or cycles before burning compute.
>
> **3. Step-level timeouts (not just agent-level)**
> Right now `timeoutMs` is on the agent. But a lead review step should timeout at 15 min while a heavy refactor step might need 30 min. Per-step timeout overrides would be more precise:
>
> ```yaml
> steps:
>   - name: lead-review
>     timeoutMs: 900_000
>   - name: heavy-refactor
>     timeoutMs: 1_800_000
> ```
>
> **4. Health heartbeats / progress streaming**
> During the long stuck runs, I had zero visibility into what the agent was doing. The SDK should expose a real-time event stream:
>
> ```typescript
> workflow.on('step:output', ({ step, chunk }) => { ... })
> workflow.on('step:heartbeat', ({ step, lastOutputAge }) => { ... })
> ```
>
> This would let the CLI show live tailing and detect stalls without relying solely on the PTY watchdog.
>
> **5. Checkpoint/resume**
> When the workflow failed at step 12 of 23, we had to restart from step 1. If step outputs are persisted (they already are in `.agent-relay/step-outputs/`), the runner should support resuming from the last completed step:
>
> ```bash
> agent-relay run workflow.yaml --resume <runId>
> ```
>
> This alone would have saved hours during debugging.
>
> **6. Smarter retry backoff**
> The retry is currently just "wait 10s, try again." If a step fails because the agent ran out of context or timed out, the retry should be able to adjust -- e.g., pass the previous attempt's output as context, or increase the timeout.
>
> **7. Decompose lead review into smaller steps**
> The lead review steps injected massive prompts (all prior step outputs concatenated). This made them slow and prone to context overflow. Better pattern:
>
> ```yaml
> - name: lead-check-types
>   prompt: "Run tsc --noEmit and report errors"
> - name: lead-check-imports
>   prompt: "Verify all imports resolve"
> - name: lead-approve
>   prompt: "Review the type check and import results"
>   dependsOn: [lead-check-types, lead-check-imports]
> ```
>
> **8. Verification should be structural, not string matching**
> Steps currently verify via `output_contains: "SOME_MARKER"`. This is fragile -- the agent might complete the work perfectly but forget to echo the marker. Better options:
> - File existence checks: `verify: { fileExists: "src/adapters/index.ts" }`
> - Command checks: `verify: { command: "tsc --noEmit", exitCode: 0 }`
> - Git diff checks: `verify: { hasChanges: true }`
>
> **9. Declare cross-repo dependencies explicitly**
> The workflow touched 3 repos but this wasn't declared anywhere. A `repos` block would make this explicit and let dry-run validate access:
>
> ```yaml
> repos:
>   dashboard: ../relay-dashboard
>   cloud: ../relay-cloud
>   cli: .
> ```
>
> **10. Default timeout guardrail in the SDK**
> No agent timeout should default to > 30 minutes. The SDK should warn or error if `timeoutMs` exceeds a threshold without explicit opt-in:
>
> ```typescript
> // SDK warns: "timeoutMs 7200000 exceeds recommended max of 1800000"
> // To override: set allowLongTimeout: true
> ```

---

## Proposed Improvements

### 1. Cross-Repo Write Access

**Priority:** P0
**Complexity:** High

**Problem:** Agents are spawned in the CLI's working directory and have no mechanism to write to sibling repositories. The `cloud-worker` agent in the `dashboard-pure-ui-refactor` workflow could not write to `../relay-cloud` and had to produce a patch file as a workaround, adding manual steps to an otherwise automated pipeline.

**Proposed Solution:** Add `cwd` and `additionalPaths` fields to `AgentDefinition`. When the broker spawns a PTY for an agent, it should `chdir` into `cwd` (resolved relative to the YAML file location). The `additionalPaths` field is informational for dry-run validation and documentation, and can be passed as allowed paths to agents that support sandboxing (e.g., Claude's `--allowedTools`).

```typescript
// In AgentDefinition (packages/sdk/src/workflows/types.ts)
export interface AgentDefinition {
  name: string;
  cli: AgentCli;
  role?: string;
  task?: string;
  channels?: string[];
  constraints?: AgentConstraints;
  interactive?: boolean;
  /** Working directory for this agent, resolved relative to the YAML file. */
  cwd?: string;
  /** Additional paths the agent needs read/write access to. */
  additionalPaths?: string[];
}
```

When the runner spawns an agent, it resolves `cwd` relative to the YAML file location and passes it to the broker's spawn command. The broker (Rust PTY layer) already accepts a working directory for child processes -- this threads it through from the workflow config.

Dry-run validation should verify that all declared `cwd` and `additionalPaths` directories exist and are accessible.

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/types.ts` -- add `cwd` and `additionalPaths` to `AgentDefinition`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- resolve `cwd` when spawning agents, pass to `AgentRelay.spawn()`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/relay.ts` -- accept and forward `cwd` in spawn options
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/relay-pty/src/pty.rs` -- ensure PTY spawn respects working directory (likely already supported)
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/dry-run-format.ts` -- add path validation warnings

---

### 2. Dry-Run Validation

**Priority:** P0
**Complexity:** Medium

**Problem:** A dry-run mode partially exists (`--dry-run` flag in the CLI, `DryRunReport` type, `formatDryRunReport()` function), but it does not validate all config aspects. For a 23-step DAG, there was no way to catch misconfigured dependencies, missing agents, or invalid step references without actually running the workflow and burning compute time.

**Proposed Solution:** Enhance the existing dry-run implementation to perform comprehensive validation:

1. **Dependency graph validation** -- detect cycles, missing dependency references, unreachable steps
2. **Agent validation** -- verify all referenced agents exist in the `agents` block
3. **Cross-repo path validation** -- check that declared `cwd` and `additionalPaths` exist on disk
4. **Timeout sanity checks** -- warn about steps without timeouts or with excessively long ones
5. **Resource estimation** -- estimate peak concurrency and total agent-minutes

The existing `--dry-run` flag in the CLI (`/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/src/cli/commands/setup.ts`, line 284) already routes through `runWorkflow()` with `dryRun: true`. The `DryRunReport` type (`/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/types.ts`, line 244) already has `errors` and `warnings` arrays. The work is adding more validation rules.

```typescript
// Enhanced validation in runner.ts dryRun() method
function validateDag(steps: WorkflowStep[], agents: AgentDefinition[]): DryRunReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Cycle detection via topological sort
  // 2. Missing dependency references
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!steps.find(s => s.name === dep)) {
        errors.push(`Step "${step.name}" depends on unknown step "${dep}"`);
      }
    }
  }

  // 3. Missing agent references
  const agentNames = new Set(agents.map(a => a.name));
  for (const step of steps) {
    if (step.agent && !agentNames.has(step.agent)) {
      errors.push(`Step "${step.name}" references unknown agent "${step.agent}"`);
    }
  }

  // 4. Timeout warnings
  for (const step of steps) {
    if (!step.timeoutMs) {
      warnings.push(`Step "${step.name}" has no timeout configured`);
    }
  }

  // ... return report
}
```

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- enhance `dryRun()` method with additional validations
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/dry-run-format.ts` -- display new validation details (path checks, timeout warnings)
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/types.ts` -- extend `DryRunReport` if needed (e.g., resource estimates)

---

### 3. Checkpoint/Resume from CLI

**Priority:** P0
**Complexity:** Medium

**Problem:** When the workflow failed at step 12 of 23, the entire workflow had to restart from step 1. Step outputs are already persisted to `.agent-relay/step-outputs/{runId}/` and the `WorkflowRunner` already has a `resume(runId)` method (`/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts`, line 732). However, there is no CLI command to invoke resume -- the `run` command in `setup.ts` does not accept a `--resume` flag.

**Proposed Solution:** Add `--resume <runId>` flag to the `agent-relay run` CLI command. When provided, the runner loads the existing run from the in-memory DB (or persisted state), identifies completed steps, and resumes from the first pending/failed step.

Since the current `InMemoryWorkflowDb` does not persist across process restarts, the resume feature also requires persisting the run state to disk. The step outputs are already on disk at `.agent-relay/step-outputs/{runId}/`; the run metadata and step statuses should be written alongside.

```bash
# First run fails at step 12
agent-relay run workflow.yaml
# Output: "Run abc123 failed at step 'lead-review-phase2'"

# Resume from where it left off
agent-relay run workflow.yaml --resume abc123
# Skips steps 1-11, resumes from step 12
```

```typescript
// Persistence: write run state after each step completion
const STATE_FILE = '.agent-relay/runs/{runId}/state.json';

interface PersistedRunState {
  run: WorkflowRunRow;
  steps: WorkflowStepRow[];
}
```

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/src/cli/commands/setup.ts` -- add `--resume <runId>` option to the `run` command
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- add disk persistence for run state (write after each step), load from disk in `resume()`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/run.ts` -- add `resume` option to `RunWorkflowOptions`, route to `runner.resume()`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/memory-db.ts` -- optionally back with file persistence, or add a file-based DB adapter

---

### 4. Step-Level Timeouts

**Priority:** P1
**Complexity:** Low

**Problem:** Timeouts are currently defined at the agent level via `AgentConstraints.timeoutMs`. However, different steps assigned to the same agent can have vastly different expected durations. A lead review step should timeout at 15 minutes, while a heavy refactor step might legitimately need 30 minutes.

**Proposed Solution:** The `WorkflowStep` type already has a `timeoutMs` field (`/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/types.ts`, line 156). The runner needs to use it with proper precedence: step-level timeout overrides agent-level timeout, which overrides swarm-level timeout.

```typescript
// Resolution order in runner.ts when starting a step:
function resolveTimeout(step: WorkflowStep, agent: AgentDefinition, swarm: SwarmConfig): number {
  return step.timeoutMs
    ?? agent.constraints?.timeoutMs
    ?? swarm.timeoutMs
    ?? DEFAULT_STEP_TIMEOUT_MS; // 1_800_000 (30 min)
}
```

Verify that the runner's step execution loop actually reads `step.timeoutMs` and applies it to the agent's PTY watchdog timer. If the current implementation only reads the agent-level timeout, wire up the step-level override.

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- ensure step-level `timeoutMs` is resolved and applied during step execution

---

### 5. Health Heartbeats and Progress Streaming

**Priority:** P1
**Complexity:** Medium

**Problem:** During long-running workflow executions, there was zero visibility into what an agent was doing. When a step hung for 30+ minutes, the only recourse was to kill the workflow and inspect logs after the fact. The existing `WorkflowEvent` type has step-level lifecycle events but no output streaming or heartbeat events.

**Proposed Solution:** Add `step:output` and `step:heartbeat` events to the `WorkflowEvent` union. The PTY broker already captures agent output; the runner should forward output chunks to event listeners as they arrive.

```typescript
// New events in runner.ts WorkflowEvent union
export type WorkflowEvent =
  | { type: 'run:started'; runId: string }
  // ... existing events ...
  | { type: 'step:output'; runId: string; stepName: string; chunk: string }
  | { type: 'step:heartbeat'; runId: string; stepName: string; lastOutputAgeMs: number };
```

The heartbeat event should fire on a regular interval (e.g., every 30 seconds) for each running step, reporting how long it has been since the agent last produced output. This allows the CLI to display a live "last activity: 45s ago" indicator and detect stalls without relying solely on the PTY watchdog.

For the CLI, add a `--tail` or `--verbose` flag to `agent-relay run` that prints `step:output` events to stderr in real time.

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- emit `step:output` events from agent output callbacks, add heartbeat timer per running step
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/src/cli/commands/setup.ts` -- add `--tail` flag to `run` command, wire up output event display

---

### 6. Structural Verification

**Priority:** P1
**Complexity:** Medium

**Problem:** Step verification currently relies on `output_contains` string matching (`VerificationCheck` type in `types.ts`, line 193). This is fragile -- an agent might complete work perfectly but forget to echo the expected marker string, causing a false failure. The `VerificationCheck` type already has a `type` field supporting `'output_contains' | 'exit_code' | 'file_exists' | 'custom'`, but only `output_contains` appears to be fully implemented in the runner.

**Proposed Solution:** Implement the remaining verification types and add new ones:

```typescript
export interface VerificationCheck {
  type: 'output_contains' | 'exit_code' | 'file_exists' | 'command' | 'git_changes' | 'custom';
  value: string;
  description?: string;
}
```

- **`file_exists`**: Check that a file exists at the given path (relative to agent cwd). Already in the type union.
- **`command`**: Run a shell command and verify exit code 0. Value is the command string.
- **`git_changes`**: Verify that `git diff --name-only` returns changes in the expected paths. Value is a glob pattern.
- **`exit_code`**: Already in the type union. Verify agent process exit code.

```yaml
steps:
  - name: extract-components
    agent: dashboard-worker
    task: "Extract shared components into @relay/ui-kit"
    verification:
      type: file_exists
      value: "packages/ui-kit/src/index.ts"

  - name: verify-types
    agent: lead
    task: "Run type checking"
    verification:
      type: command
      value: "tsc --noEmit"
```

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- implement `file_exists`, `command`, and `git_changes` verification handlers
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/types.ts` -- add `'command'` and `'git_changes'` to the `VerificationCheck.type` union

---

### 7. Default Timeout Guardrail

**Priority:** P1
**Complexity:** Low

**Problem:** Without an explicit timeout, an agent step can run indefinitely. During debugging, agents ran for over an hour without producing useful output, consuming resources and blocking the workflow. There is no SDK-level guardrail to prevent this.

**Proposed Solution:** Add a default maximum timeout in the SDK (30 minutes). If a step or agent specifies a `timeoutMs` exceeding 30 minutes, the SDK emits a warning. To suppress the warning, the user sets `allowLongTimeout: true` at the swarm or step level.

```typescript
const RECOMMENDED_MAX_TIMEOUT_MS = 1_800_000; // 30 minutes
const DEFAULT_STEP_TIMEOUT_MS = 1_800_000;

// In runner.ts, when resolving step timeout:
if (resolvedTimeout > RECOMMENDED_MAX_TIMEOUT_MS && !step.allowLongTimeout && !swarm.allowLongTimeout) {
  this.emit({
    type: 'warning',
    message: `Step "${step.name}" timeout ${resolvedTimeout}ms exceeds recommended max of ${RECOMMENDED_MAX_TIMEOUT_MS}ms. Set allowLongTimeout: true to suppress.`,
  });
}
```

Steps without any timeout configured should default to `DEFAULT_STEP_TIMEOUT_MS` rather than running indefinitely.

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- add default timeout, add warning for excessive timeouts
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/types.ts` -- add `allowLongTimeout?: boolean` to `WorkflowStep` and `SwarmConfig`

---

### 8. Smarter Retry Backoff

**Priority:** P2
**Complexity:** Medium

**Problem:** The retry mechanism waits a flat 10 seconds and re-runs the step identically. If the failure was due to context overflow or a timeout, the same failure will recur. There is no mechanism to adapt the retry strategy based on the failure mode.

**Proposed Solution:** Add a `retryStrategy` configuration to steps and the global error handling config. The runner should classify failures (timeout, context overflow, verification failure, crash) and apply different retry behaviors.

```typescript
export interface RetryStrategy {
  /** Base delay between retries in ms. Default: 10_000. */
  delayMs?: number;
  /** Multiplier for exponential backoff. Default: 1 (no backoff). */
  backoffMultiplier?: number;
  /** Pass previous attempt output as context to the retry. Default: false. */
  includeFailureContext?: boolean;
  /** Increase timeout by this factor on retry. Default: 1 (no increase). */
  timeoutScaleFactor?: number;
}
```

```yaml
steps:
  - name: heavy-refactor
    agent: dashboard-worker
    task: "Refactor components"
    retries: 2
    retryStrategy:
      delayMs: 15000
      backoffMultiplier: 2
      includeFailureContext: true
      timeoutScaleFactor: 1.5
```

When `includeFailureContext` is true, the retry prompt includes a summary like: "Previous attempt failed with: [error]. The partial output was: [truncated output]. Please continue from where it left off."

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/types.ts` -- add `RetryStrategy` interface and `retryStrategy` field to `WorkflowStep`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- implement backoff logic, failure classification, and context injection on retry

---

### 9. Decompose Lead Reviews (Workflow Design Guidance)

**Priority:** P2
**Complexity:** Low (documentation/guidance, not code)

**Problem:** Lead review steps injected massive prompts containing all prior step outputs concatenated together. This made them slow and prone to context overflow. This is a workflow design problem rather than a system limitation.

**Proposed Solution:** Document a best-practice pattern for decomposing large review steps into smaller, focused checks. This is primarily a documentation change, plus optionally adding a dry-run warning when a step depends on more than N upstream steps.

**Recommended Pattern:**

```yaml
# Instead of one monolithic review step:
#   - name: lead-review
#     dependsOn: [step1, step2, step3, step4, step5, step6]
#     task: "Review all changes"

# Decompose into focused checks:
- name: check-types
  type: deterministic
  command: "cd ../relay-dashboard && npx tsc --noEmit"
  dependsOn: [extract-components, update-imports]

- name: check-lint
  type: deterministic
  command: "cd ../relay-dashboard && npm run lint"
  dependsOn: [extract-components, update-imports]

- name: lead-approve
  agent: lead
  task: "Review the type check and lint results, approve if clean"
  dependsOn: [check-types, check-lint]
```

The dry-run validator could warn: "Step 'lead-review' depends on 6 upstream steps. Consider decomposing into smaller verification steps to reduce context size."

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- add dry-run warning for steps with many dependencies (threshold: 5+)
- Documentation: add workflow design best practices to SDK README or a dedicated guide

---

### 10. Cross-Repo Declarations

**Priority:** P2
**Complexity:** Low

**Problem:** The workflow touched 3 repositories but this was not declared anywhere in the YAML config. There was no way for dry-run validation to check path accessibility or for the runner to set up working directories.

**Proposed Solution:** Add an optional top-level `repos` block to `RelayYamlConfig`. This is purely declarative -- it names the repositories and their relative paths. Dry-run validation uses it to verify paths exist. Agent `cwd` fields reference repo names from this block.

```typescript
// In RelayYamlConfig (types.ts)
export interface RelayYamlConfig {
  version: string;
  name: string;
  description?: string;
  /** Named repository paths used by this workflow. */
  repos?: Record<string, string>;
  swarm: SwarmConfig;
  agents: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  // ... existing fields
}
```

```yaml
repos:
  dashboard: ../relay-dashboard
  cloud: ../relay-cloud
  cli: .

agents:
  - name: dashboard-worker
    cli: claude
    cwd: repos.dashboard  # resolved from repos block
  - name: cloud-worker
    cli: codex
    cwd: repos.cloud
```

Dry-run validation resolves each repo path relative to the YAML file and checks:
- Directory exists
- Directory is a git repository (warning if not)
- Agent `cwd` references resolve to a declared repo

**Files to Modify:**
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/types.ts` -- add `repos?: Record<string, string>` to `RelayYamlConfig`
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/runner.ts` -- resolve repo paths during config parsing, validate in dry-run
- `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/packages/sdk/src/workflows/dry-run-format.ts` -- display repos in dry-run output

---

## Operational Bugs Fixed (Reference)

These three PTY broker bugs were discovered and fixed during the `dashboard-pure-ui-refactor` debugging sessions. They are documented here because they directly inform why improvements like heartbeats, checkpoint/resume, and better observability matter -- without these fixes, the workflow system was fundamentally unreliable.

### Bug 1: `shutdown()` blocking forever on `child.wait()`

**Symptom:** After a PTY child process exited (or was killed), calling `shutdown()` on the broker would hang indefinitely. The workflow runner would appear frozen during cleanup.

**Root Cause:** The `has_exited()` check reaped the child process (consuming its exit status), but `shutdown()` subsequently called `child.wait()` which blocked forever because the exit status had already been consumed.

**Fix:** Replaced `child.wait()` in `shutdown()` with a `try_wait()` polling loop that checks a `reaped` flag. If the child was already reaped by `has_exited()`, shutdown returns immediately.

**File:** `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/relay-pty/src/pty.rs`

### Bug 2: Init broker unable to detect dead PTY workers

**Symptom:** The broker's `reap_exited()` function, which runs periodically to clean up dead workers, failed to detect workers that had crashed or been killed externally. Dead workers accumulated and blocked new spawns.

**Root Cause:** `reap_exited()` only checked the portable-pty exit status, which was unreliable for processes killed by external signals. It did not fall back to OS-level process existence checks.

**Fix:** Added a `kill(pid, 0)` (signal 0) check as a fallback. If `kill` returns `ESRCH` (no such process), the worker is marked as exited and reaped.

**File:** `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/relay-pty/src/pty.rs`

### Bug 3: `has_exited()` failing when portable-pty returned no PID

**Symptom:** `has_exited()` panicked or returned incorrect results when the portable-pty child handle did not provide a PID (which can happen in certain terminal configurations or race conditions during spawn).

**Root Cause:** The code unconditionally unwrapped the PID from the child handle. When portable-pty returned `None` for the PID, the function failed.

**Fix:** Added dynamic PID re-query on each `has_exited()` call. If the PID is still unavailable after a threshold number of consecutive checks (3), the worker is presumed dead and marked for reaping.

**File:** `/Users/khaliqgant/Projects/agent-workforce/relay-cli-uses-broker/relay-pty/src/pty.rs`

---

## Success Metrics

The workflow system improvements are complete when:

1. **First-attempt success:** A 20+ step DAG workflow completes on its first attempt without manual intervention, given correct configuration and no external failures.

2. **Resume from failure:** When a workflow fails at step N, `agent-relay run workflow.yaml --resume <runId>` resumes execution from step N, skipping all previously completed steps. Completed step outputs are preserved and available to downstream steps.

3. **Pre-flight validation:** `agent-relay run workflow.yaml --dry-run` catches all configuration errors (missing agents, cycle in dependencies, unreachable steps, invalid paths) before any agents are spawned. Zero compute is consumed by invalid configurations.

4. **Cross-repo workflows:** Agents can write directly to sibling repositories declared in the workflow config. No patch file workarounds are needed.

5. **Real-time visibility:** During execution, the operator can see live agent output and a heartbeat indicator showing time since last activity. Stalled agents are detectable within 60 seconds.

6. **Timeout safety:** All steps have a default timeout (30 minutes). Steps exceeding the default require explicit opt-in. No workflow can run indefinitely due to a missing timeout.

---

## Implementation Order

| Phase | Items | Estimated Effort |
|-------|-------|-----------------|
| Phase 1 (P0) | Checkpoint/resume CLI, Enhanced dry-run validation, Cross-repo write access | 2-3 weeks |
| Phase 2 (P1) | Step-level timeout resolution, Health heartbeats, Structural verification, Default timeout guardrail | 2 weeks |
| Phase 3 (P2) | Smarter retry backoff, Lead review decomposition guidance, Cross-repo declarations | 1-2 weeks |

Phase 1 targets the items that directly caused the 8-hour debugging overhead. Phase 2 improves operational confidence. Phase 3 refines the developer experience.
