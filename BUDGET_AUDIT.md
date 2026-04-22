# Token Budget Tracking — Audit Report

## 1. Token Collection: Exact File Locations

### Collection Entry Point

- **`packages/sdk/src/workflows/cli-session-collector.ts:51-58`** — `collectCliSession()` dispatches to CLI-specific collectors based on `AgentCli` type
- **`packages/sdk/src/workflows/cli-session-collector.ts:38-49`** — `createCollector()` factory: supports `claude`, `codex`, `opencode`; returns `null` for all other CLIs

### CLI-Specific Collectors

| Collector   | File                             | Token Extraction                                                                                                                                                                |
| ----------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `collectors/claude.ts:87-186`    | Parses `~/.claude/projects/<project>/<sessionId>.jsonl`; sums `usage.input_tokens`, `usage.output_tokens`, `cache_read_input_tokens` from each `assistant` entry (line 123-128) |
| Codex       | `collectors/codex.ts:149-169`    | Reads `~/.codex/state_5.sqlite` `threads` table; extracts `input_tokens`, `output_tokens`, `cache_read_tokens` columns (or falls back to `tokens_used`)                         |
| OpenCode    | `collectors/opencode.ts:222-231` | Reads `~/.local/share/opencode/opencode.db` `message` table; sums `tokens.input`, `tokens.output`, `tokens.cache.read` from JSON `data` column                                  |

### CliSessionReport Shape (`cli-session-collector.ts:6-24`)

```typescript
interface CliSessionReport {
  cli: AgentCli;
  tokens: { input: number; output: number; cacheRead: number } | null;
  cost: number | null; // Only OpenCode populates this
  durationMs: number | null;
  model: string | null;
  turns: number;
  errors: { turn: number; text: string }[];
  finalStatus: 'completed' | 'failed' | 'unknown';
  // ...
}
```

## 2. Token Data Flow

```
CLI session files (JSONL / SQLite)
        │
        ▼
collectCliSession()                    (cli-session-collector.ts:51)
        │
        ▼
captureAgentReport()                   (runner.ts:6623-6650)
  ├─ this.agentReports.set(stepName)   (runner.ts:6642)  — in-memory Map
  ├─ this.emit('step:agent-report')    (runner.ts:6643)  — event for listeners
  └─ persistAgentReport()              (runner.ts:7135-7143) — writes <step>.report.json
        │
        ▼
formatRunSummaryTable()                (run-summary-table.ts:41-110)
  reads from agentReports Map          (runner.ts:6833)
  displays: Step | Status | Model | Cost | Tokens | Duration | Errors
```

### Key Details

- **`agentReports`** is declared as `private readonly agentReports = new Map<string, CliSessionReport>()` at **runner.ts:482**
- Cleared at workflow start: **runner.ts:2860** (`this.agentReports.clear()`)
- Populated post-execution per step: **runner.ts:6634-6642**
- Displayed in final summary: **runner.ts:6833**
- Token formatting in table: `run-summary-table.ts:8-12` sums `input + output + cacheRead`

## 3. Where maxTokens Is Currently Referenced (NO Enforcement)

| Location         | Line                                                           | Usage                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts:206`   | `AgentConstraints.maxTokens?: number`                          | **Field definition only**                                                                                                                             |
| `runner.ts:1663` | `agentDef.constraints?.maxTokens ?? proxyConfig.defaultBudget` | Used as `budget` in **credential proxy JWT** — passed to `mintProxyToken()` for the proxy's own rate limiting. **NOT enforced by the runner itself.** |
| `runner.ts:3995` | `specialistDef.constraints?.maxTokens`                         | Passed as `defaultMaxTokens` to API-mode executor config. **NOT enforced during execution.**                                                          |

**Finding: The runner reads `maxTokens` but never checks actual token consumption against the budget. There is zero enforcement at the workflow/runner level.**

## 4. Timeout Enforcement Pattern to Follow

The timeout enforcement in `waitForExitWithIdleNudging()` (**runner.ts:6338-6470**) provides the exact structural pattern for token budget enforcement:

### Timeout Pattern Structure

```
1. CONFIGURATION:  timeoutMs from step.timeoutMs or swarm.timeoutMs
2. LOOP:           while (true) { ... }
3. TRACKING:       elapsed = Date.now() - startTime
4. CHECK:          remaining = timeoutMs - elapsed; if (remaining <= 0) return 'timeout'
5. WAIT:           exitResult = await agent.waitForExit(waitMs)
6. GRACE:          On timeout, check verification before hard-failing (runner.ts:6169-6196)
7. ESCALATION:     Nudge → escalate → force-release progression
```

### Proposed Token Budget Enforcement (Same Structure)

```
1. CONFIGURATION:  maxTokens from step agent's constraints.maxTokens
2. LOOP:           Poll token consumption periodically during execution
3. TRACKING:       currentTokens = read from agentReports or live polling
4. CHECK:          if (currentTokens >= maxTokens) → trigger budget exceeded
5. WAIT:           Continue waiting for exit with budget check interval
6. GRACE:          On budget exceeded, allow current turn to complete
7. ESCALATION:     Warn at 80% → soft-stop at 100% → force-release at 110%
```

### Enforcement Hook Points

| Phase                | Location                                                     | Action                                                         |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| **Pre-spawn**        | `executeAgentStep()` (~runner.ts:6050)                       | Validate maxTokens is set; calculate remaining workflow budget |
| **During execution** | Inside `waitForExitWithIdleNudging()` loop (~runner.ts:6424) | Periodically poll token usage; compare against budget          |
| **Post-execution**   | `captureAgentReport()` (~runner.ts:6623)                     | Record final token count; deduct from workflow-level budget    |

### Challenge: Live Token Polling

The current collectors (`claude.ts`, `codex.ts`, `opencode.ts`) read session files **after** the agent exits. For mid-execution enforcement, one of these approaches is needed:

1. **Tail the session JSONL** (Claude) or poll the SQLite DB (Codex/OpenCode) periodically during execution
2. **Use the credential proxy's own budget tracking** — the proxy already receives the budget via JWT and could reject requests when exhausted
3. **Parse PTY output** for token usage patterns (fragile, CLI-specific)

**Recommendation**: Option 2 (credential proxy enforcement) for hard limits, with Option 1 (periodic polling) for soft warnings and reporting.

## 5. Edge Cases

### 5a. Concurrent Parallel Steps Sharing a Workflow Budget

- Currently: each step's `maxTokens` is independent (per-agent constraint)
- No workflow-level `maxTokens` field exists in `WorkflowDefinition` (types.ts:467-474)
- **Gap**: If 5 parallel agents each have `maxTokens: 100_000`, the workflow could consume 500K tokens with no aggregate cap
- **Fix needed**: Add `maxTokens` to `WorkflowDefinition` or `SwarmConfig`; maintain an `AtomicBudget` counter decremented by each step's actual consumption; use `Atomics` or a mutex for thread-safe concurrent deductions

### 5b. Retry Attempts Consuming from the Same Budget

- Retries are configured via `step.retries` (types.ts:552) and `AgentConstraints.retries` (types.ts:208)
- Current retry logic re-spawns the agent with the same constraints
- **Gap**: Each retry gets a fresh `maxTokens` budget (via new JWT), not the remaining budget from prior attempts
- **Fix needed**: Track cumulative tokens across retries in `StepState`; deduct prior attempt's actual consumption from retry budget; fail the step if cumulative consumption exceeds `maxTokens × (retries + 1)` or a separate `maxTokensPerStep` field

### 5c. Non-Interactive vs Interactive Agents

- **Interactive agents** (PTY mode, `interactive: true`): Token collection works via session file parsing after exit. Mid-execution polling possible by tailing session files.
- **Non-interactive agents** (`interactive: false`): Run as child processes with stdout capture. Token collection still works post-execution (collectors read the same session files). However, non-interactive agents using `preset: 'worker'` may not write session files if they're invoked with `--print` or similar flags.
- **API-mode agents** (`cli: 'api'`): Use `executeApiStep()` (runner.ts:45) — token usage comes directly from API response `usage` field. Easiest to enforce in real-time.
- **Gap**: No unified mid-execution token query interface across all three modes

### 5d. Steps That Fail Before Collection Happens

- `captureAgentReport()` is called in the step lifecycle regardless of success/failure (runner.ts:6623-6650)
- But if a step crashes before the CLI writes any session data (e.g., spawn failure, immediate OOM), `collectCliSession()` returns `null` (cli-session-collector.ts:53)
- **Gap**: Tokens consumed before crash are lost — the partial consumption is not tracked
- **Fix needed**: For credential proxy mode, the proxy itself tracks per-session token consumption server-side. Query the proxy for actual consumption on step failure. For non-proxy mode, accept that crash-before-write results in underreporting.

### 5e. Additional Edge Case: Token Counts Available Only After Exit

- Claude collector reads `~/.claude/projects/.../<sessionId>.jsonl` which is written incrementally — can be tailed
- Codex collector reads `~/.codex/state_5.sqlite` — SQLite is updated during execution, can be polled
- OpenCode collector reads `~/.local/share/opencode/opencode.db` — same as Codex
- **All three can theoretically be polled mid-execution**, but the current `CliSessionCollector` interface (`collect()`) is designed for post-execution one-shot reads, not streaming

## Summary

| Component                         | Status              | Location                                    |
| --------------------------------- | ------------------- | ------------------------------------------- |
| Token collection (post-execution) | IMPLEMENTED         | cli-session-collector.ts + collectors/\*.ts |
| Token storage in memory           | IMPLEMENTED         | runner.ts:482 (agentReports Map)            |
| Token persistence to disk         | IMPLEMENTED         | runner.ts:7135-7143 (\*.report.json)        |
| Token display in summary          | IMPLEMENTED         | run-summary-table.ts                        |
| maxTokens field in types          | DEFINED             | types.ts:206                                |
| maxTokens passed to proxy JWT     | IMPLEMENTED         | runner.ts:1663-1688                         |
| maxTokens enforcement in runner   | **NOT IMPLEMENTED** | —                                           |
| Mid-execution token polling       | **NOT IMPLEMENTED** | —                                           |
| Workflow-level aggregate budget   | **NOT IMPLEMENTED** | —                                           |
| Cross-retry budget tracking       | **NOT IMPLEMENTED** | —                                           |
