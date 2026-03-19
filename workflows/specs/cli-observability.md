# CLI Observability & Workflow API Improvements

## Status: Draft
## Target: `@agent-relay/sdk` v3.3.0 (`packages/sdk` in `AgentWorkforce/relay`)

---

## Problem

When a workflow step backed by an AI CLI (OpenCode, Claude Code, Codex) fails or
behaves unexpectedly, debugging requires manually parsing ANSI-escaped terminal
logs or running ad-hoc SQLite/JSONL queries against each CLI's local storage.
The structured data already exists — it just isn't collected or presented.

Additionally, the workflow API forces one-agent-per-working-directory because
`cwd` is only available on `AgentDefinition`, not on individual steps.

---

## Changes

### 1. Step-level `cwd` on the builder API

**File:** `packages/sdk/src/workflows/builder.ts`, `types.ts`

Add `cwd` to `AgentStepOptions` and `DeterministicStepOptions`:

```typescript
// builder.ts — AgentStepOptions
export interface AgentStepOptions {
    agent: string;
    task: string;
    cwd?: string;              // <-- NEW
    dependsOn?: string[];
    verification?: VerificationCheck;
    timeoutMs?: number;
    retries?: number;
}

// builder.ts — DeterministicStepOptions
export interface DeterministicStepOptions {
    type: 'deterministic';
    command: string;
    cwd?: string;              // <-- NEW
    captureOutput?: boolean;
    failOnError?: boolean;
    dependsOn?: string[];
    verification?: VerificationCheck;
    timeoutMs?: number;
}
```

**Runner change** (`runner.ts`): In `executeAgentStep` and `executeDeterministicStep`,
resolve effective cwd as: `step.cwd ?? resolveStepWorkdir(step) ?? resolveAgentCwd(agentDef) ?? this.cwd`.

**Before:**
```typescript
wf.agent('gen-create', { cli: 'opencode', cwd: 'workspaces/notion-create-page', ... });
wf.agent('gen-update', { cli: 'opencode', cwd: 'workspaces/notion-update-page', ... });
```

**After:**
```typescript
wf.agent('generator', { cli: 'opencode', preset: 'worker', ... });
wf.step('gen-create', { agent: 'generator', cwd: 'workspaces/notion-create-page', ... });
wf.step('gen-update', { agent: 'generator', cwd: 'workspaces/notion-update-page', ... });
```

---

### 2. CLI Session Collector (`CliSessionCollector`)

**New file:** `packages/sdk/src/workflows/cli-session-collector.ts`

A pluggable module that, given a CLI type and step execution metadata (cwd, start
time, end time), queries the CLI's local storage and returns a structured report.

#### 2a. Collector interface

```typescript
export interface CliSessionReport {
    cli: AgentCli;
    sessionId: string | null;
    model: string | null;
    provider: string | null;
    durationMs: number | null;
    cost: number | null;
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
    } | null;
    turns: number;
    toolCalls: { name: string; count: number }[];
    errors: { turn: number; text: string }[];
    finalStatus: 'completed' | 'failed' | 'unknown';
    summary: string | null;        // agent's final text output
    raw?: object;                  // full parsed session for advanced consumers
}

export interface CliSessionQuery {
    cli: AgentCli;
    cwd: string;                   // step's resolved working directory
    startedAt: number;             // unix ms
    completedAt: number;           // unix ms
}

export interface CliSessionCollector {
    canCollect(): boolean;         // check if CLI data store is accessible
    collect(query: CliSessionQuery): Promise<CliSessionReport | null>;
}
```

#### 2b. OpenCode collector

**Source:** `~/.local/share/opencode/opencode.db` (SQLite)

```
session (id, directory, time_created) →
message (session_id, data JSON: { role, modelID, providerID, cost, tokens, finish }) →
part    (session_id, message_id, data JSON: { type, text })
```

**Matching strategy:** Find the session where `directory = query.cwd` and
`time_created BETWEEN query.startedAt AND query.completedAt`, ordered by
`time_created DESC`, limit 1.

**Token aggregation:** Sum `data.tokens.input`, `data.tokens.output`,
`data.tokens.cache.read` across all messages in the session.

**Tool call extraction:** From `part` rows where `data.type = 'tool-call'`,
group by `data.name`, count occurrences.

**Error extraction:** From `part` rows where `data.type = 'text'`, scan for
lines starting with `Error`, `error:`, `Command failed`, or `FAIL`.

**Permissions:** Read-only access via `better-sqlite3` or `sql.js`. If the DB
file doesn't exist or is locked, `canCollect()` returns false.

#### 2c. Claude Code collector

**Source:** `~/.claude/history.jsonl` (session index) +
`~/.claude/projects/{encoded-path}/{session-id}.jsonl` (full session log)

**History format (per line):**
```json
{
    "display": "user prompt",
    "timestamp": 1773050849717,
    "project": "/absolute/path",
    "sessionId": "uuid"
}
```

**Matching strategy:** Read `history.jsonl` bottom-up, find the entry where
`project` matches `query.cwd` and `timestamp` falls within the step window.
Then read the corresponding session JSONL from
`~/.claude/projects/{encoded-path}/{sessionId}.jsonl`.

**Session JSONL format:** Each line has `type` (`user`, `assistant`, `tool_use`,
`tool_result`, `system`, `progress`), plus role/content fields.

**Token/cost extraction:** Look for assistant messages with usage metadata.
Claude Code stores token counts in the assistant message metadata.

**Error extraction:** Scan tool_result lines for error indicators.

#### 2d. Codex collector

**Source:** `~/.codex/history.jsonl` (session index) +
`~/.codex/state_5.sqlite` (rich session data)

**History format (per line):**
```json
{
    "session_id": "uuid",
    "ts": 1773050849,
    "text": "full prompt"
}
```

**SQLite schema:**
```
threads (id, cwd, model_provider, tokens_used, created_at, updated_at)
logs    (thread_id, ts, level, message)
```

**Matching strategy:** Query the `threads` table for `cwd = query.cwd` and
`created_at` within the step window.

**Token extraction:** `threads.tokens_used` gives the total.

**Error extraction:** Query `logs` where `level = 'error'` and
`thread_id = matched_thread.id`.

#### 2e. Fallback (other CLIs)

For CLIs without a known local data store (gemini, aider, goose, droid), the
collector returns `null`. The runner falls back to the existing PTY output
scraping via `extractOutputExcerpt`.

---

### 3. Runner integration

**File:** `packages/sdk/src/workflows/runner.ts`

#### 3a. New event: `step:agent-report`

Add to `WorkflowEvent` union:

```typescript
| {
    type: 'step:agent-report';
    runId: string;
    stepName: string;
    report: CliSessionReport;
}
```

Emitted after every agent step completes (success or failure), before
`step:completed` / `step:failed`. If the collector returns `null`, the event
is not emitted.

#### 3b. Collection timing

After `spawnAndWait` returns and before the completion decision:

```typescript
// In executeAgentStep, after agent exits:
const report = await this.collectCliSession({
    cli: agentDef.cli,
    cwd: effectiveCwd,
    startedAt: stepStartTime,
    completedAt: Date.now(),
});
if (report) {
    this.emit({ type: 'step:agent-report', runId, stepName, report });
    // Persist alongside step output
    this.persistAgentReport(runId, stepName, report);
}
```

#### 3c. Report persistence

Write `{stepName}.report.json` alongside `{stepName}.md` in
`.agent-relay/step-outputs/{runId}/`.

#### 3d. Run summary table

Enhance `logRunSummary` to print a table when agent reports are available:

```
=== Run Summary ============================================================
Step              Status  Model     Cost    Tokens   Duration  Errors
scaffold-create   pass    --        --      --       1.2s      --
gen-create-page   pass    kimi-k2   $0.04   15,683   2m 39s    2 (fixed)
verify-create     pass    --        --      --       3.4s      --
scaffold-update   pass    --        --      --       1.1s      --
gen-update-page   pass    kimi-k2   $0.05   18,389   1m 51s    3 (fixed)
verify-update     pass    --        --      --       4.1s      --
────────────────────────────────────────────────────────────────────────────
Total                               $0.09   34,072   5m 20s
============================================================================
```

For failed steps, include the first error line:

```
gen-create-page   FAIL    kimi-k2   $0.02   8,201    0m 42s    1
  └─ Error [6:19] Expected 2-3 arguments, but got 1.
```

---

### 4. Model format validation in preflight

**File:** `packages/sdk/src/workflows/runner.ts` — `runPreflightChecks`

Add a validation pass over agent definitions:

- **OpenCode:** Model must match `provider/model` format or a known alias
  (resolve aliases from `~/.config/opencode/config.json` if readable).
  Warn on formats like `kimi-2.5` that don't match any known pattern.
- **Claude Code:** Model must be a valid Anthropic model ID.
- **Codex:** Model must be a valid OpenAI model ID.

This is a **warning**, not a hard error — CLIs may have custom model aliases.
Surface it in the `DryRunReport.warnings` array.

---

### 5. Step-level `env`

**File:** `packages/sdk/src/workflows/builder.ts`, `types.ts`, `runner.ts`

Add `env` to step options:

```typescript
export interface AgentStepOptions {
    // ...existing fields
    env?: Record<string, string>;  // <-- NEW
}
```

Runner passes these as additional environment variables when spawning the
subprocess. Useful for passing connection IDs, API keys, or test data without
embedding them in the task prompt.

---

### 6. Inline `setup` command on agent steps

**File:** `packages/sdk/src/workflows/builder.ts`, `types.ts`, `runner.ts`

```typescript
export interface AgentStepOptions {
    // ...existing fields
    setup?: string;  // <-- NEW: shell command run before agent spawn
}
```

When present, the runner executes `setup` as a deterministic sub-step in the
step's `cwd` before spawning the agent. If it fails (non-zero exit), the step
fails without invoking the agent.

This eliminates the boilerplate scaffold + dependsOn pattern:

```typescript
// Before: two steps
wf.step('scaffold-create', { type: 'deterministic', command: 'mkdir -p ...' });
wf.step('gen-create', { agent: 'gen', dependsOn: ['scaffold-create'], ... });

// After: one step
wf.step('gen-create', { agent: 'gen', setup: 'mkdir -p ...', ... });
```

---

## Implementation order

1. **Step-level `cwd`** — unblocks single-agent-multi-workspace pattern
2. **CliSessionCollector interface + OpenCode collector** — highest debugging value
3. **Runner integration (event + persistence + summary table)** — surfaces the data
4. **Claude Code collector** — second most common CLI
5. **Codex collector** — third CLI
6. **Model format validation** — nice-to-have for preflight
7. **Step-level `env`** — convenience
8. **Inline `setup`** — convenience

---

## Testing

- **Step-level cwd:** Unit test that agent step resolves `step.cwd` > `agent.cwd` > runner `cwd`.
- **Collectors:** Integration tests with fixture SQLite DBs and JSONL files.
  Mock the file paths to point at test fixtures.
- **Summary table:** Snapshot test of formatted output given mock reports.
- **Preflight validation:** Unit test with valid/invalid model formats per CLI.
