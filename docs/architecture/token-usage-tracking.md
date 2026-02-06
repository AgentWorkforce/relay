# Token Usage Tracking

## Status: RFC (Request for Comments)

## Problem Statement

When a user orchestrates multiple agents through agent-relay, they have no visibility into aggregate token consumption. Each CLI tool (Claude, Codex, Gemini, etc.) meters usage independently through its own platform, but there is no unified view across an orchestration session. A lead agent spawning 5 workers has no way to know the total cost of the operation, set budgets, or detect runaway consumption.

This is a critical primitive for production multi-agent workflows where cost control is non-negotiable.

## Design Principles

1. **SDK-first** — The SDK (`@agent-relay/sdk`) is the primary interface. Every other surface (CLI, dashboard, MCP) is a thin layer on top of SDK methods. If it can't be done from the SDK, it doesn't exist.
2. **Developer experience over infrastructure** — Start with what code you write, work backwards to what the system needs.
3. **Event-driven** — Usage updates flow as real-time events through callbacks, not just poll-based queries.
4. **Budget at spawn time** — Cost limits are set where work is created: `spawn()`, `createRelay()`, and configuration.
5. **Progressive fidelity** — Works immediately with estimates, gets precise when real data is available.

## Non-Goals

- Replacing provider-level billing (Anthropic Console, OpenAI Dashboard, etc.)
- Sub-request granularity (e.g., tracking individual tool calls within a single turn)
- Real-time streaming of token counts during generation (we capture post-completion)

---

## Part 1: SDK Interface (Developer Experience)

Everything starts here. This is what a developer writes.

### 1.1 Basic Usage Tracking

```typescript
import { createRelay } from '@agent-relay/sdk';

const relay = await createRelay();
const lead = await relay.client('Lead');

// Spawn workers
await lead.spawn({ name: 'Writer', cli: 'claude', task: 'Write the docs' });
await lead.spawn({ name: 'Reviewer', cli: 'claude:opus', task: 'Review the code' });

// Check usage at any point — like client.state, always available
const usage = await lead.getUsage();
console.log(usage.totalCostUsd);        // 0.42
console.log(usage.totalTokens.input);   // 45230
console.log(usage.totalTokens.output);  // 12450
console.log(usage.byAgent);             // per-agent breakdown
```

`getUsage()` is the single entry point. No separate commands for "by agent" vs "by model" — it always returns the full picture and you destructure what you need.

### 1.2 Real-Time Usage Events

```typescript
// Stream usage updates as they arrive
lead.onUsageUpdate = (report) => {
  console.log(`${report.agentName} used ${report.tokens.input} input tokens`);
  console.log(`Running total: $${report.runningTotalCostUsd}`);
};
```

This fires every time the daemon receives a usage report from any agent in the session. The `report` includes the per-agent delta AND the running session total, so the consumer never has to do aggregation math.

### 1.3 Budget at Spawn Time

The most natural place to set a cost limit is where you create work:

```typescript
// Per-agent budget: kill this worker if it exceeds $2
await lead.spawn({
  name: 'ExpensiveWorker',
  cli: 'claude:opus',
  task: 'Analyze the entire codebase',
  budget: { maxCostUsd: 2.00 },
});

// Session-wide budget: set on the relay itself
const relay = await createRelay({
  budget: {
    maxCostUsd: 10.00,
    onExceeded: 'pause',       // 'warn' | 'pause' | 'kill'
    warningThreshold: 0.8,     // alert at 80%
  },
});
```

When a budget is exceeded:
- `'warn'` — Fires `onBudgetAlert` callback; agents keep running
- `'pause'` — Agents are paused (no new input injected); lead is notified
- `'kill'` — Agent is released with reason `'budget_exceeded'`

### 1.4 Budget Alerts

```typescript
lead.onBudgetAlert = (alert) => {
  console.log(`Budget warning: ${alert.percentUsed * 100}% used`);
  console.log(`Agent: ${alert.agentName}, Limit: $${alert.limitValue}`);

  if (alert.action === 'pause') {
    // Lead can decide: release the worker or increase the budget
    lead.setBudget(alert.agentName, { maxCostUsd: 5.00 }); // increase
    // or
    lead.release(alert.agentName, 'Too expensive');
  }
};
```

### 1.5 Self-Reporting Usage (SDK Agents)

For agents built directly with the SDK (not PTY-wrapped CLIs), they can report their own usage:

```typescript
// SDK-based agent reports its own token consumption
const worker = new RelayClient({ agentName: 'Worker' });
await worker.connect();

// After calling an LLM API directly
const completion = await anthropic.messages.create({ ... });

worker.reportUsage({
  input: completion.usage.input_tokens,
  output: completion.usage.output_tokens,
  cacheRead: completion.usage.cache_read_input_tokens,
  cacheWrite: completion.usage.cache_creation_input_tokens,
  model: 'claude-sonnet-4',
});
```

This is the highest-fidelity path: the agent has exact numbers from the API response and reports them directly through the relay protocol. No parsing, no estimation.

### 1.6 Query Usage Programmatically

```typescript
// Get usage for a specific agent
const workerUsage = await lead.getUsage({ agent: 'Writer' });

// Get usage for a team
const teamUsage = await lead.getUsage({ team: 'frontend' });

// Get usage since a specific time
const recentUsage = await lead.getUsage({ since: Date.now() - 60_000 });

// Get per-model breakdown
console.log(workerUsage.byModel);
// [{ model: 'claude-sonnet-4', tokens: {...}, costUsd: 0.23 }]
```

### 1.7 Full Example: Cost-Aware Orchestration

This is what production code looks like — the SDK makes cost a first-class concern:

```typescript
import { createRelay } from '@agent-relay/sdk';

const relay = await createRelay({
  budget: { maxCostUsd: 15.00, warningThreshold: 0.7 },
});

const lead = await relay.client('Lead');

// Cost-aware model selection: start cheap, escalate if needed
await lead.spawn({ name: 'Analyzer', cli: 'claude:haiku', task: 'Triage the issues' });

lead.onMessage = async (from, { body, data }) => {
  if (from === 'Analyzer' && data?.needsDeepAnalysis) {
    // Check budget before spawning expensive agent
    const usage = await lead.getUsage();
    const remaining = 15.00 - usage.totalCostUsd;

    if (remaining > 5.00) {
      await lead.spawn({
        name: 'DeepAnalyzer',
        cli: 'claude:opus',
        task: `Deep analysis: ${body}`,
        budget: { maxCostUsd: remaining * 0.5 }, // use at most half of what's left
      });
    } else {
      lead.sendMessage('Analyzer', 'Budget tight — summarize what you have');
    }
  }
};

lead.onBudgetAlert = (alert) => {
  if (alert.percentUsed > 0.9) {
    // Emergency: release all non-essential workers
    lead.release('DeepAnalyzer', 'budget_pressure');
  }
};

lead.onUsageUpdate = (report) => {
  lead.sendLog(`Cost: $${report.runningTotalCostUsd.toFixed(2)} / $15.00`);
};
```

---

## Part 2: Data Model

### TokenUsage (the core shape)

Every usage-related API returns or accepts this shape:

```typescript
interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface TokenUsageReport {
  /** Agent that generated this usage */
  agentName: string;
  /** Session ID */
  sessionId: string;
  /** CLI type */
  cli: string;
  /** Model identifier */
  model?: string;
  /** Timestamp (Unix ms) */
  ts: number;
  /** Token counts for this report */
  tokens: TokenCounts;
  /** Estimated cost in USD */
  costUsd: number;
  /** Running total cost across the entire session (all agents) */
  runningTotalCostUsd: number;
  /** Running total tokens across the entire session (all agents) */
  runningTotalTokens: TokenCounts;
  /** How this data was collected */
  source: 'sdk' | 'output_parse' | 'file_report' | 'estimated';
}
```

The key DX decision: every report includes both the per-agent delta AND the running session total. The consumer never has to aggregate. This is what makes `onUsageUpdate` useful — you always know the full picture from a single event.

### UsageSummary (query response)

```typescript
interface UsageSummary {
  /** Total tokens across all agents in scope */
  totalTokens: TokenCounts;
  /** Total estimated cost in USD */
  totalCostUsd: number;
  /** Time range of the data */
  from: number;
  to: number;
  /** Per-agent breakdown */
  byAgent: AgentUsage[];
  /** Per-model breakdown */
  byModel: ModelUsage[];
  /** Budget status (if a budget is set) */
  budget?: BudgetStatus;
}

interface AgentUsage {
  agentName: string;
  cli: string;
  model?: string;
  tokens: TokenCounts;
  costUsd: number;
  turnCount: number;
  /** Per-agent budget status (if set) */
  budget?: BudgetStatus;
}

interface ModelUsage {
  model: string;
  tokens: TokenCounts;
  costUsd: number;
  agentCount: number;
}

interface BudgetStatus {
  maxCostUsd?: number;
  maxTotalTokens?: number;
  currentCostUsd: number;
  currentTotalTokens: number;
  percentUsed: number;
  onExceeded: 'warn' | 'pause' | 'kill';
  /** Whether the budget has been exceeded */
  exceeded: boolean;
}
```

### UsageBudget (configuration)

```typescript
interface UsageBudget {
  /** Maximum estimated cost in USD */
  maxCostUsd?: number;
  /** Maximum total tokens (input + output) */
  maxTotalTokens?: number;
  /** Action when budget is exceeded */
  onExceeded?: 'warn' | 'pause' | 'kill';
  /** Warning threshold (0-1, default 0.8) */
  warningThreshold?: number;
}
```

Simple. No separate "per-agent token limit" vs "per-agent cost limit" — just `maxCostUsd` and `maxTotalTokens`. Applied at two levels:
- **Session-wide** via `createRelay({ budget })` or `lead.setSessionBudget()`
- **Per-agent** via `spawn({ budget })` or `lead.setBudget(agentName, budget)`

---

## Part 3: SDK API Surface

### New Methods on RelayClient

```typescript
class RelayClient {
  // === Existing methods ===
  // connect(), disconnect(), sendMessage(), spawn(), release(), etc.

  // === New: Usage Tracking ===

  /**
   * Report token usage from this agent.
   * Used by SDK-built agents that call LLM APIs directly.
   */
  reportUsage(usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    model?: string;
  }): boolean;

  /**
   * Query token usage for the current session.
   * Returns aggregated usage with per-agent and per-model breakdowns.
   */
  getUsage(options?: {
    agent?: string;
    team?: string;
    since?: number;
  }): Promise<UsageSummary>;

  // === New: Budget Management ===

  /**
   * Set or update the session-wide budget.
   */
  setSessionBudget(budget: UsageBudget): Promise<void>;

  /**
   * Set or update budget for a specific agent.
   */
  setBudget(agentName: string, budget: UsageBudget): Promise<void>;

  // === New: Callbacks ===

  /**
   * Fired when any agent in the session reports usage.
   * Includes both the per-agent delta and running session totals.
   */
  onUsageUpdate?: (report: TokenUsageReport) => void;

  /**
   * Fired when a budget threshold or limit is reached.
   */
  onBudgetAlert?: (alert: BudgetAlert) => void;
}
```

### Budget Alert Shape

```typescript
interface BudgetAlert {
  /** Which budget was triggered */
  scope: 'session' | 'agent';
  /** Agent name (for per-agent budgets) */
  agentName?: string;
  /** Budget type that was exceeded */
  budgetType: 'cost' | 'tokens';
  /** Current value */
  currentValue: number;
  /** Limit value */
  limitValue: number;
  /** Percentage consumed (0-1) */
  percentUsed: number;
  /** Action being taken */
  action: 'warn' | 'pause' | 'kill';
  /** Whether this is the final exceeded alert (vs. a warning threshold alert) */
  exceeded: boolean;
}
```

### Extended Spawn Options

```typescript
// Existing spawn signature, extended with budget
await client.spawn({
  name: string;
  cli: string;
  task?: string;
  // ... existing options ...

  /** Per-agent usage budget */
  budget?: UsageBudget;
});
```

### Extended createRelay Options

```typescript
const relay = await createRelay({
  socketPath?: string;
  quiet?: boolean;

  /** Session-wide usage budget */
  budget?: UsageBudget;

  /** Custom model pricing (merged with defaults) */
  pricing?: Record<string, ModelPricing>;
});
```

---

## Part 4: Data Collection (How Usage Data Gets In)

The system collects usage data through multiple channels, ordered by fidelity. The SDK unifies them all behind the same `TokenUsageReport` shape.

### Source 1: SDK Self-Report (highest fidelity)

Agents built with the SDK call `client.reportUsage()` with exact numbers from their LLM API responses. This sends a `USAGE_REPORT` envelope to the daemon with `source: 'sdk'`.

This is the primary path for production orchestrations. When you build a swarm with the SDK, your agents have direct access to API responses and can report exact token counts.

```typescript
// Agent reports exact usage from Anthropic API response
const response = await anthropic.messages.create({ model: 'claude-sonnet-4', ... });
worker.reportUsage({
  input: response.usage.input_tokens,
  output: response.usage.output_tokens,
  cacheRead: response.usage.cache_read_input_tokens,
  model: 'claude-sonnet-4',
});
```

### Source 2: Output Parsing (PTY-wrapped CLIs)

For agents spawned as CLI processes (Claude Code, Codex, Gemini), the wrapper's output parser extracts usage from terminal output. Each CLI has a parser module:

```typescript
// packages/wrapper/src/usage-parsers/index.ts
interface UsageParser {
  cli: string;
  parseLine(line: string): Partial<TokenCounts> | null;
  parseSessionEnd(lines: string[]): { tokens: TokenCounts; model?: string } | null;
}
```

The wrapper sends `USAGE_REPORT` to the daemon with `source: 'output_parse'`. The SDK consumer doesn't need to know or care that the data came from parsing — it arrives through the same `onUsageUpdate` callback.

**CLI output patterns** (the fragile part — isolated into per-CLI modules):

| CLI | Pattern | Frequency |
|-----|---------|-----------|
| Claude Code | Status line with cost/tokens after each turn | Per-turn |
| Claude Code | Session summary on exit | Session end |
| Codex | `Tokens used: X prompt + Y completion` | Session end |
| Gemini | `Token count: X input, Y output` | Per-response |
| Aider | `Tokens: X sent, Y received. Cost: $Z` | Per-edit |

### Source 3: File-Based Report (fallback for any CLI)

Agents write to `$AGENT_RELAY_OUTBOX/usage`. Consistent with the existing outbox protocol:

```
KIND: usage
INPUT_TOKENS: 12345
OUTPUT_TOKENS: 3456
MODEL: claude-sonnet-4
```

The outbox monitor picks this up and forwards as `USAGE_REPORT` with `source: 'file_report'`.

### Source 4: Estimation (lowest fidelity, always available)

When no real data is available, the system estimates based on relay message sizes. Clearly marked as `source: 'estimated'` in all APIs and UI. Provides a floor — "at least this many tokens were used" — not a ceiling.

### Priority & Deduplication

When multiple sources report for the same agent:
- Higher-fidelity source wins (`sdk` > `output_parse` > `file_report` > `estimated`)
- The daemon deduplicates by (agentName, turnNumber) — a later `sdk` report for turn 5 replaces an earlier `output_parse` report for turn 5
- Estimates are replaced by real data as it arrives; the `onUsageUpdate` callback fires again with corrected values

---

## Part 5: Protocol

### New Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `USAGE_REPORT` | Client → Daemon | Report token usage |
| `USAGE_QUERY` | Client → Daemon | Query aggregated usage |
| `USAGE_RESPONSE` | Daemon → Client | Usage query response |
| `BUDGET_SET` | Client → Daemon | Set/update a budget |
| `BUDGET_ALERT` | Daemon → Client(s) | Budget threshold or limit reached |
| `USAGE_UPDATE` | Daemon → Client(s) | Broadcast usage update to subscribers |

### USAGE_REPORT Payload

```typescript
interface UsageReportPayload {
  tokens: TokenCounts;
  model?: string;
  source: 'sdk' | 'output_parse' | 'file_report' | 'estimated';
  /** Optional turn number for deduplication */
  turnNumber?: number;
  /** If true, these are cumulative totals (not per-turn deltas) */
  cumulative?: boolean;
}
```

### USAGE_UPDATE Payload (daemon → subscribers)

After receiving and processing a `USAGE_REPORT`, the daemon broadcasts an `USAGE_UPDATE` to all connected clients that have subscribed to usage updates. This is what powers the `onUsageUpdate` callback:

```typescript
interface UsageUpdatePayload {
  /** The agent that generated the usage */
  agentName: string;
  /** Per-agent token delta */
  tokens: TokenCounts;
  /** Per-agent cost delta */
  costUsd: number;
  /** Session running totals */
  sessionTotalTokens: TokenCounts;
  sessionTotalCostUsd: number;
  /** Model used */
  model?: string;
  /** Data source */
  source: 'sdk' | 'output_parse' | 'file_report' | 'estimated';
}
```

### BUDGET_SET Payload

```typescript
interface BudgetSetPayload {
  /** 'session' for session-wide, or agent name for per-agent */
  scope: string;
  budget: UsageBudget;
}
```

### BUDGET_ALERT Payload

```typescript
interface BudgetAlertPayload {
  scope: 'session' | 'agent';
  agentName?: string;
  budgetType: 'cost' | 'tokens';
  currentValue: number;
  limitValue: number;
  percentUsed: number;
  action: 'warn' | 'pause' | 'kill';
  exceeded: boolean;
}
```

### Subscription Model

Clients opt into usage updates by subscribing to the `usage` topic. The SDK does this automatically when `onUsageUpdate` or `onBudgetAlert` is set:

```typescript
// SDK auto-subscribes when callback is set
client.onUsageUpdate = (report) => { ... };
// Internally: client.subscribe('_usage');
```

---

## Part 6: Pricing

### Built-In Pricing Table

```typescript
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4':   { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30, cacheWritePer1M: 3.75 },
  'claude-opus-4':     { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50, cacheWritePer1M: 18.75 },
  'claude-haiku-3.5':  { inputPer1M: 0.80, outputPer1M: 4.00, cacheReadPer1M: 0.08, cacheWritePer1M: 1.00 },
  'gpt-4o':            { inputPer1M: 2.50, outputPer1M: 10.00 },
  'gpt-4o-mini':       { inputPer1M: 0.15, outputPer1M: 0.60 },
  'o3':                { inputPer1M: 10.00, outputPer1M: 40.00 },
  'gemini-2.5-pro':    { inputPer1M: 1.25, outputPer1M: 10.00 },
  'gemini-2.5-flash':  { inputPer1M: 0.15, outputPer1M: 0.60 },
};
```

### Model Resolution

When a `USAGE_REPORT` arrives, the daemon resolves the model for cost calculation:

1. `model` field from the report (highest priority — exact model from API response)
2. `model` from the agent's HELLO handshake payload
3. Inferred from `cli` field via `model-mapping.ts` (e.g., `claude:opus` → `claude-opus-4`)
4. Falls back to cheapest model for that CLI family (conservative estimate)

### Custom Pricing

```typescript
// Via SDK
const relay = await createRelay({
  pricing: {
    'my-fine-tuned-model': { inputPer1M: 5.00, outputPer1M: 20.00 },
  },
});

// Via file: ~/.agent-relay/pricing.json or .agent-relay/pricing.json
// Custom entries merge with (and override) defaults
```

---

## Part 7: CLI Interface

The CLI is a thin layer over SDK methods, aimed at operators and humans monitoring sessions.

### `agent-relay usage`

```bash
# Current session (default: all agents, table format)
agent-relay usage

# Specific agent
agent-relay usage --agent Worker1

# JSON output (for scripting)
agent-relay usage --json

# Live mode (refreshes every 2s)
agent-relay usage --live
```

**Table output:**
```
 Agent      Model       In Tok    Out Tok   Cache     Cost      Budget
 ─────────  ──────────  ────────  ────────  ────────  ────────  ────────
 Lead       opus-4       45,230    12,450    30,100    $4.28
 Writer     sonnet-4     23,100     8,340    15,200    $0.20    $2.00 (10%)
 Reviewer   sonnet-4     18,500     5,200     9,800    $0.15
 Shadow     haiku-3.5     8,900     2,100     6,000    $0.02
 ─────────  ──────────  ────────  ────────  ────────  ────────
 TOTAL                   95,730    28,090    61,100    $4.65    $15.00 (31%)

 Session s_abc123 | 12m 34s | Sources: sdk (2), output_parse (1), estimated (1)
```

Key UX decisions:
- Budget column only appears when budgets are set
- Percentage shows how much of the budget is consumed
- Source summary at bottom so you know data quality
- No `--by-agent` / `--by-model` flags — the table always shows both; use `--json` for programmatic access

### `agent-relay budget`

```bash
# Set session budget
agent-relay budget set --max-cost 10.00
agent-relay budget set --max-cost 10.00 --on-exceeded pause --warn-at 0.8

# Set per-agent budget
agent-relay budget set --agent Worker1 --max-cost 2.00

# View budget status
agent-relay budget status

# Clear budget
agent-relay budget clear
agent-relay budget clear --agent Worker1
```

**Status output:**
```
 Session Budget: $10.00 (on exceeded: pause, warn at 80%)
   Current: $4.65 (46.5%)
   ████████████░░░░░░░░░░░░░  46%

 Per-Agent Budgets:
   Writer:  $0.20 / $2.00 (10%)  ██░░░░░░░░░░░░░░░░░░░░░░  10%
```

---

## Part 8: Dashboard UI

The dashboard (`public/index.html`) gains a usage panel that provides real-time cost visibility during orchestration sessions.

### Usage Panel (Main View)

Embedded in the existing agent grid view. Each agent card shows a cost badge:

```
┌─────────────────────────────┐
│ Writer (claude:sonnet)      │
│ Status: active              │
│ Task: Write the docs        │
│                             │
│ Tokens: 23.1K in / 8.3K out│
│ Cost: $0.20                 │
│ ████░░░░░░  10% of $2.00   │
└─────────────────────────────┘
```

### Session Cost Bar (Header)

Always visible at the top of the dashboard when usage data exists:

```
Session Cost: $4.65 / $15.00    ████████████░░░░░░░░░░░░░  31%
  Lead: $4.28  Writer: $0.20  Reviewer: $0.15  Shadow: $0.02
```

Color coding:
- Green: < warning threshold
- Yellow: > warning threshold, < 100%
- Red: exceeded, pulsing if action is `'kill'`

### Cost Timeline (Expandable)

A sparkline or area chart showing cumulative cost over session duration. Each agent is a stacked area so you can see who's driving cost:

```
$5 ┤                                    ╭──── Lead (opus)
   │                              ╭─────╯
   │                        ╭─────╯
$2 ┤              ╭─────────╯
   │        ╭─────╯───────────────────── Writer (sonnet)
$1 ┤  ╭─────╯
   │──╯─────────────────────────────────  Reviewer + Shadow
$0 ┤
   └──────────────────────────────────── time
   0m       5m       10m       15m
```

### WebSocket Push

The dashboard connects as a system client and subscribes to `_usage`. Usage updates stream in real-time — no polling. The MCP server uses the same `USAGE_QUERY` / `USAGE_RESPONSE` protocol as the SDK.

### MCP Tools

```typescript
'relay-usage'          // Get usage summary (same as client.getUsage())
'relay-budget-set'     // Set budget (same as client.setSessionBudget())
'relay-budget-status'  // Get budget status
```

---

## Part 9: Storage

Usage data is stored alongside messages in the existing storage layer.

### SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cli TEXT NOT NULL,
  model TEXT,
  ts INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  turn_number INTEGER,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX idx_token_usage_session ON token_usage(session_id);
CREATE INDEX idx_token_usage_agent_session ON token_usage(agent_name, session_id);

-- Running totals maintained in memory by the daemon for fast budget checks.
-- Storage is the source of truth for historical queries.
```

### JSONL Format

```json
{"id":"u_abc","agent":"Writer","session":"s_xyz","cli":"claude","model":"claude-sonnet-4","ts":1706000000000,"tokens":{"in":12345,"out":3456,"cacheR":8000},"cost":0.042,"source":"sdk"}
```

### StorageAdapter Extension

```typescript
interface StorageAdapter {
  // ... existing methods ...

  saveUsageReport?(report: StoredUsageReport): Promise<void>;
  getUsageReports?(query: UsageQuery): Promise<StoredUsageReport[]>;
  getUsageSummary?(sessionId: string, options?: { agent?: string; since?: number }): Promise<UsageSummary>;
}
```

---

## Part 10: Daemon Integration

### UsageAggregator

A new component in the daemon that:
1. Receives `USAGE_REPORT` from wrappers and SDK clients
2. Maintains in-memory running totals per session (for fast budget checks)
3. Persists to storage
4. Evaluates budget rules and sends `BUDGET_ALERT`
5. Broadcasts `USAGE_UPDATE` to subscribed clients
6. Deduplicates by (agentName, turnNumber, source) — higher fidelity wins

```typescript
class UsageAggregator {
  private sessionTotals: Map<string, { byAgent: Map<string, TokenCounts>; total: TokenCounts; totalCostUsd: number }>;
  private budgets: { session?: UsageBudget; perAgent: Map<string, UsageBudget> };

  handleReport(report: UsageReportPayload, fromAgent: string, sessionId: string): {
    update: UsageUpdatePayload;
    alert?: BudgetAlertPayload;
  };

  getSummary(sessionId: string, options?: { agent?: string }): UsageSummary;
  setBudget(scope: string, budget: UsageBudget): void;
}
```

The aggregator lives in the daemon's main event loop. When a `USAGE_REPORT` arrives:

```
USAGE_REPORT (from wrapper/SDK)
  → Resolve model & compute cost (pricing table)
  → Deduplicate (skip if lower-fidelity report for same turn exists)
  → Update in-memory totals
  → Persist to storage
  → Check budgets → BUDGET_ALERT (if threshold crossed)
  → Broadcast USAGE_UPDATE (to all _usage subscribers)
```

### Telemetry Events

Following existing PostHog patterns in `packages/telemetry/src/events.ts`:

```typescript
interface UsageReportTelemetryEvent {
  cli: string;
  source: 'sdk' | 'output_parse' | 'file_report' | 'estimated';
  has_cache_data: boolean;
}

interface BudgetAlertTelemetryEvent {
  scope: 'session' | 'agent';
  budget_type: 'cost' | 'tokens';
  percent_used: number;
  action: 'warn' | 'pause' | 'kill';
}
```

---

## Part 11: Implementation Plan

### Phase 1: SDK Core + Protocol (ship first)

The SDK is the primary interface, so it ships first.

- `TokenCounts`, `UsageSummary`, `UsageBudget` types in `packages/protocol/`
- `USAGE_REPORT`, `USAGE_QUERY`, `USAGE_RESPONSE`, `BUDGET_SET`, `BUDGET_ALERT`, `USAGE_UPDATE` message types
- `client.reportUsage()` — SDK self-reporting
- `client.getUsage()` — query daemon for summary
- `client.onUsageUpdate` / `client.onBudgetAlert` callbacks
- `UsageAggregator` in daemon (in-memory totals + storage persist)
- `spawn({ budget })` and `createRelay({ budget })` integration
- `client.setSessionBudget()` and `client.setBudget()`
- SQLite storage schema
- Built-in pricing table

**This phase alone makes the feature fully usable for SDK-built orchestrations.**

### Phase 2: PTY Agent Support

- Claude Code output parser
- Codex, Gemini, Aider output parser modules
- `UsageCollector` in `packages/wrapper/` hooked into `RelayPtyOrchestrator`
- File-based reporting via `$AGENT_RELAY_OUTBOX/usage`
- Estimation fallback
- Source deduplication / priority logic

### Phase 3: CLI + Dashboard UX

- `agent-relay usage` command (table, JSON, live modes)
- `agent-relay budget` command (set, status, clear)
- Dashboard usage panel (agent cards with cost badges)
- Session cost bar in dashboard header
- Cost timeline chart
- MCP tools (`relay-usage`, `relay-budget-set`, `relay-budget-status`)
- JSONL adapter support

### Phase 4: Advanced

- Cost timeline analytics (historical cost per session over days/weeks)
- Custom pricing via SDK and config files
- Usage export (CSV, JSON)
- Telemetry events
- Usage alerts via channels (post to #cost-alerts)

---

## Decisions (not open questions)

These were listed as "open questions" in the prior draft. Decided here:

1. **Usage data flows through the relay protocol.** Same socket, same framing. The volume is tiny (one small envelope per agent turn) compared to messages. Consistency > optimization.

2. **Model is resolved from spawn config when not reported.** The `cli` field in `SpawnPayload` (e.g., `claude:opus`) maps to a model via the existing `model-mapping.ts`. No new infrastructure needed.

3. **The lead agent has full access to worker usage.** This is what makes cost-aware orchestration possible. `getUsage()` returns data for all agents the caller can see (same visibility as `listWorkers()`).

4. **Default reporting granularity is cumulative.** The daemon stores cumulative snapshots per agent. Diffs are computed on read when needed. This is simpler to implement, easier to reason about, and what the SDK consumer actually wants ("how much has this agent used total?").

5. **Reports are forwarded to daemon per-turn, not batched.** One envelope per agent turn is negligible load. Batching adds latency to budget enforcement which defeats the purpose.

---

## Appendix: Type Exports

All types are exported from `@agent-relay/sdk` and `@agent-relay/protocol`:

```typescript
import type {
  // Usage
  TokenCounts,
  TokenUsageReport,
  UsageSummary,
  AgentUsage,
  ModelUsage,

  // Budget
  UsageBudget,
  BudgetStatus,
  BudgetAlert,

  // Pricing
  ModelPricing,

  // Protocol
  UsageReportPayload,
  UsageUpdatePayload,
  BudgetSetPayload,
  BudgetAlertPayload,
} from '@agent-relay/sdk';
```
