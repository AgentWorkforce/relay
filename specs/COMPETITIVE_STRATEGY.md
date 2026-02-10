# Competitive Strategy Spec: Getting Ahead of Rivet Sandbox Agent

**Status:** Proposed
**Date:** 2026-02-10
**Authors:** Agent Relay Team
**Target:** v3.0

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Competitive Landscape](#2-competitive-landscape)
3. [Strategic Pillars](#3-strategic-pillars)
4. [Pillar 1: Universal Agent Event Schema](#4-pillar-1-universal-agent-event-schema)
5. [Pillar 2: HTTP Control & Permission API](#5-pillar-2-http-control--permission-api)
6. [Pillar 3: SSE Event Streaming](#6-pillar-3-sse-event-streaming)
7. [Pillar 4: Orchestration Patterns as First-Class Features](#7-pillar-4-orchestration-patterns-as-first-class-features)
8. [Pillar 5: OpenAPI Specification](#8-pillar-5-openapi-specification)
9. [Pillar 6: Python SDK](#9-pillar-6-python-sdk)
10. [Pillar 7: Docker Container Isolation](#10-pillar-7-docker-container-isolation)
11. [Pillar 8: Cost & Token Tracking](#11-pillar-8-cost--token-tracking)
12. [Pillar 9: ACP Compatibility Layer](#12-pillar-9-acp-compatibility-layer)
13. [Pillar 10: OTel-Native Tracing Export](#13-pillar-10-otel-native-tracing-export)
14. [Dashboard Enhancements](#14-dashboard-enhancements)
15. [Implementation Roadmap](#15-implementation-roadmap)
16. [What NOT to Do](#16-what-not-to-do)
17. [Success Metrics](#17-success-metrics)

---

## 1. Executive Summary

Rivet's Sandbox Agent SDK (launched 2026-01-28, 720 GitHub stars in 2 weeks) threatens Relay's position by offering a clean HTTP API for controlling coding agents in sandboxed environments. While Relay leads in multi-agent orchestration, Rivet leads in developer ergonomics and standardization.

**The strategy:** Adopt Rivet's best ergonomics (event schema, HTTP API, SSE streaming) while doubling down on orchestration — the thing they can't easily replicate. Layer in standards alignment (ACP, OTel, A2A) to ensure Relay is the coordination layer the ecosystem converges on, not a proprietary island.

**The goal:** Make Relay the obvious choice when someone goes from "I need one agent in a sandbox" (Rivet) to "I need agents working together" (Relay) — with zero friction in the transition.

---

## 2. Competitive Landscape

### Direct Competitors

| Product | Core Value | Threat Level | Our Advantage |
|---------|-----------|--------------|---------------|
| **Rivet Sandbox Agent** | Universal agent API for sandboxes | **High** | No agent-to-agent messaging |
| **ACP (Zed/JetBrains)** | Editor-to-agent standard | **Medium** | Editor-focused, not orchestration |
| **Google A2A** | Enterprise agent-to-agent | **Low** (different market) | Real-time vs enterprise batch |
| **AGNTCY (Cisco)** | Internet of Agents | **Low** (early stage) | Production-ready vs spec-stage |

### Rivet's Specific Strengths to Counter

1. **Universal Session Schema** — 8 normalized event types for all agent activity
2. **Clean HTTP + SSE API** with OpenAPI spec — language-agnostic client generation
3. **~15MB static Rust binary** — zero runtime dependencies
4. **Human-in-the-loop over HTTP** — approve/deny tool calls remotely
5. **Embedded + Server modes** — run locally or in any sandbox

### Rivet's Weaknesses to Exploit

1. **No agent-to-agent messaging** (our entire value prop)
2. **No orchestration primitives** (no consensus, no roles, no task queues)
3. **Only 4 agents supported** (we support 6+)
4. **No Python SDK** (both of us lack this — first mover wins)
5. **Shallow inspector UI** (our dashboard is far richer)
6. **No session persistence** (we have cloud + continuity)
7. **Tiny team (5 people)** — can't match our feature velocity
8. **No enterprise features** (no RBAC, audit, SOC 2)

---

## 3. Strategic Pillars

Ten initiatives, prioritized by competitive impact:

| Priority | Pillar | Impact | Effort | Blocks Rivet? |
|----------|--------|--------|--------|---------------|
| **P0** | Universal Agent Event Schema | Critical | Medium | Yes — prevents their schema from becoming standard |
| **P0** | HTTP Control & Permission API | Critical | Low | Yes — matches their best feature |
| **P0** | SSE Event Streaming | Critical | Low | Yes — direct competitive parity |
| **P1** | Orchestration Patterns | High | Medium | Yes — widens our moat |
| **P1** | OpenAPI Specification | High | Low | Yes — enables language-agnostic adoption |
| **P1** | Python SDK | High | Low | Yes — first mover in ML/AI audience |
| **P2** | Docker Container Isolation | Medium | Medium | Partial — addresses local sandbox gap |
| **P2** | Cost & Token Tracking | Medium | Low | No — but enterprise differentiator |
| **P2** | ACP Compatibility Layer | Medium | Medium | No — defensive standards play |
| **P3** | OTel-Native Tracing Export | Medium | Low | No — ecosystem integration |

---

## 4. Pillar 1: Universal Agent Event Schema

### Why

Rivet normalizes all agent output into 8 event types. If their schema becomes the standard for agent observability and replay, they own the abstraction layer — like how OpenTelemetry owns distributed tracing.

We already see more than Rivet does (we wrap agents via PTY and capture full terminal output). We should define a richer schema that's a superset of theirs.

### Schema Definition

```typescript
/**
 * Agent Relay Universal Event Schema (ARES) v1
 *
 * Normalizes activity from any coding agent (Claude Code, Codex, Gemini, Aider,
 * Goose, OpenCode, Amp) into a standard event stream.
 *
 * Superset of Rivet Sandbox Agent's session schema.
 */

// ─── Session Lifecycle ──────────────────────────────────────────────────
interface SessionStartedEvent {
  type: 'session.started';
  sessionId: string;
  agent: AgentIdentifier;
  startedAt: number;         // Unix ms
  config: SessionConfig;
}

interface SessionEndedEvent {
  type: 'session.ended';
  sessionId: string;
  endedAt: number;
  reason: 'completed' | 'released' | 'crashed' | 'timeout';
  summary?: SessionSummary;
}

// ─── Agent Activity ─────────────────────────────────────────────────────
interface ItemStartedEvent {
  type: 'item.started';
  sessionId: string;
  itemId: string;
  itemType: ItemType;
  startedAt: number;
  metadata?: Record<string, unknown>;
}

interface ItemDeltaEvent {
  type: 'item.delta';
  sessionId: string;
  itemId: string;
  delta: Delta;
}

interface ItemCompletedEvent {
  type: 'item.completed';
  sessionId: string;
  itemId: string;
  completedAt: number;
  result?: unknown;
  duration: number;          // ms
}

// ─── Human-in-the-Loop ─────────────────────────────────────────────────
interface PermissionRequestedEvent {
  type: 'permission.requested';
  sessionId: string;
  requestId: string;
  tool: string;              // e.g., "bash", "write", "edit"
  command?: string;          // e.g., the bash command
  filePath?: string;         // e.g., the file being edited
  description: string;       // Human-readable description
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

interface PermissionResolvedEvent {
  type: 'permission.resolved';
  sessionId: string;
  requestId: string;
  resolution: 'approved' | 'denied' | 'timeout';
  resolvedBy: string;        // Agent name or 'human' or 'policy'
  resolvedAt: number;
}

interface QuestionRequestedEvent {
  type: 'question.requested';
  sessionId: string;
  questionId: string;
  question: string;
  options?: string[];
  defaultAnswer?: string;
}

interface QuestionResolvedEvent {
  type: 'question.resolved';
  sessionId: string;
  questionId: string;
  answer: string;
  resolvedBy: string;
}

// ─── Relay-Exclusive Events (NOT in Rivet) ──────────────────────────────

/** Agent-to-agent message exchange */
interface MessageExchangedEvent {
  type: 'message.exchanged';
  sessionId: string;
  from: string;
  to: string | '*';
  body: string;
  kind: 'message' | 'action' | 'state' | 'thinking';
  thread?: string;
  channel?: string;
}

/** Agent spawned/released lifecycle */
interface AgentSpawnedEvent {
  type: 'agent.spawned';
  sessionId: string;
  agentName: string;
  cli: string;
  spawnedBy: string;
  task?: string;
  role?: string;
}

interface AgentReleasedEvent {
  type: 'agent.released';
  sessionId: string;
  agentName: string;
  releasedBy: string;
  reason: string;
}

/** Consensus events */
interface ConsensusProposedEvent {
  type: 'consensus.proposed';
  sessionId: string;
  proposalId: string;
  title: string;
  proposedBy: string;
  participants: string[];
  consensusType: string;
}

interface ConsensusResolvedEvent {
  type: 'consensus.resolved';
  sessionId: string;
  proposalId: string;
  outcome: 'approved' | 'rejected' | 'timeout';
  votes: Record<string, 'approve' | 'reject' | 'abstain'>;
}

/** Cost/token tracking */
interface TokenUsageEvent {
  type: 'tokens.used';
  sessionId: string;
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
}

/** File operations (richer than Rivet's tool_call events) */
interface FileOperationEvent {
  type: 'file.operation';
  sessionId: string;
  operation: 'read' | 'write' | 'edit' | 'delete' | 'create';
  filePath: string;
  linesChanged?: number;
  diff?: string;             // Unified diff for edits
}

/** Command execution */
interface CommandExecutedEvent {
  type: 'command.executed';
  sessionId: string;
  command: string;
  exitCode: number;
  duration: number;          // ms
  stdout?: string;           // Truncated
  stderr?: string;           // Truncated
}

// ─── Supporting Types ───────────────────────────────────────────────────

interface AgentIdentifier {
  name: string;
  cli: string;               // 'claude' | 'codex' | 'gemini' | 'aider' | 'goose' | 'opencode'
  model?: string;
  version?: string;
}

interface SessionConfig {
  permissionMode?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
}

interface SessionSummary {
  duration: number;
  itemCount: number;
  filesModified: string[];
  commandsRun: number;
  totalTokens?: number;
  estimatedCost?: number;
}

type ItemType =
  | 'message'                // LLM text output
  | 'tool_call'              // Tool invocation (bash, edit, write, etc.)
  | 'thinking'               // Agent reasoning
  | 'plan'                   // Agent planning step
  | 'search'                 // Code/web search
  | 'test_run'               // Test execution
  | 'build';                 // Build command

interface Delta {
  type: 'text' | 'tool_input' | 'tool_output';
  content: string;
}

// ─── Union Type ─────────────────────────────────────────────────────────

type AgentEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | ItemStartedEvent
  | ItemDeltaEvent
  | ItemCompletedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | QuestionRequestedEvent
  | QuestionResolvedEvent
  | MessageExchangedEvent
  | AgentSpawnedEvent
  | AgentReleasedEvent
  | ConsensusProposedEvent
  | ConsensusResolvedEvent
  | TokenUsageEvent
  | FileOperationEvent
  | CommandExecutedEvent;
```

### Rivet Compatibility

The first 8 event types (`session.*`, `item.*`, `permission.*`, `question.*`) map 1:1 to Rivet's schema. This means:

- Tools built for Rivet's event stream work with ours
- We emit a strict superset — everything Rivet has, plus orchestration events
- Migration from Rivet is zero-effort for the common events

### Implementation

**Where events are generated:**

| Event | Source |
|-------|--------|
| `session.*` | `relay-pty` wrapper on agent spawn/exit |
| `item.*` | OutputParser (already parses tool calls, thinking, messages) |
| `permission.*` | PTY output parser detecting permission prompts |
| `question.*` | PTY output parser detecting question prompts |
| `message.*` | Daemon router (already has this data) |
| `agent.*` | Spawner package (already tracks lifecycle) |
| `consensus.*` | Daemon consensus engine (already implemented) |
| `tokens.*` | OutputParser (parse usage stats from agent output) |
| `file.*` | OutputParser (parse tool call details) |
| `command.*` | OutputParser (parse bash command output) |

**Key insight:** We already capture all this data via PTY monitoring and output parsing. This feature is primarily about *normalizing and exposing* it, not capturing new signals.

**New protocol message:**

```typescript
// Add to protocol
interface AgentEventPayload {
  event: AgentEvent;
}

// Message type: 'AGENT_EVENT'
// Direction: Daemon -> Clients (broadcast to subscribers)
```

**Storage:**

Events stored in JSONL format alongside messages:
```
~/.agent-relay/projects/{hash}/events.jsonl
```

Each line is a JSON-encoded `AgentEvent` with an added `_seq` field for ordering.

### File-Based Protocol Extension

Agents can emit events via the outbox:

```bash
cat > $AGENT_RELAY_OUTBOX/event << 'EOF'
KIND: event
TYPE: file.operation
OPERATION: edit
PATH: src/auth.ts
LINES_CHANGED: 15
EOF
```

### SDK API

```typescript
class RelayClient {
  events: {
    /** Subscribe to events for a specific agent or all agents */
    subscribe(options?: EventSubscribeOptions): AsyncIterable<AgentEvent>;

    /** Emit a custom event */
    emit(event: AgentEvent): void;

    /** Query historical events */
    query(options: EventQueryOptions): Promise<AgentEvent[]>;

    /** Get session summary */
    getSessionSummary(sessionId: string): Promise<SessionSummary>;
  };
}

interface EventSubscribeOptions {
  agent?: string;           // Filter by agent (default: all)
  types?: AgentEvent['type'][];  // Filter by event type
  since?: number;           // Start from timestamp
}

interface EventQueryOptions {
  sessionId?: string;
  agent?: string;
  types?: AgentEvent['type'][];
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}
```

---

## 5. Pillar 2: HTTP Control & Permission API

### Why

Rivet's `permission.requested` / `permission.resolved` flow over HTTP is their most enterprise-compelling feature. Our dashboard has approval controls, but they're not exposed as a standalone API. Any web application should be able to implement human-in-the-loop without building a dashboard.

### New REST Endpoints

Add to the existing dashboard API (port 3888):

```
# ─── Permission Management ──────────────────────────────────────────────

GET    /api/v1/agents/:name/permissions
       List pending permission requests for an agent.

       Response: {
         permissions: [{
           requestId: string,
           tool: string,
           command?: string,
           filePath?: string,
           description: string,
           riskLevel: 'low' | 'medium' | 'high' | 'critical',
           requestedAt: number,
           timeout?: number
         }]
       }

POST   /api/v1/agents/:name/permissions/:requestId/approve
       Approve a permission request.

       Body: { reason?: string }
       Response: { success: boolean }

POST   /api/v1/agents/:name/permissions/:requestId/deny
       Deny a permission request.

       Body: { reason?: string }
       Response: { success: boolean }

# ─── Question/Answer ────────────────────────────────────────────────────

GET    /api/v1/agents/:name/questions
       List pending questions from an agent.

       Response: {
         questions: [{
           questionId: string,
           question: string,
           options?: string[],
           defaultAnswer?: string,
           askedAt: number
         }]
       }

POST   /api/v1/agents/:name/questions/:questionId/answer
       Answer a question.

       Body: { answer: string }
       Response: { success: boolean }

# ─── Agent Control ──────────────────────────────────────────────────────

POST   /api/v1/agents/:name/pause
       Pause an agent (stop injecting messages, queue them).

       Response: { success: boolean }

POST   /api/v1/agents/:name/resume
       Resume a paused agent (flush queued messages).

       Response: { success: boolean }

POST   /api/v1/agents/:name/stop
       Gracefully stop an agent.

       Body: { reason?: string }
       Response: { success: boolean }

POST   /api/v1/agents/:name/input
       Send raw input to an agent's PTY.

       Body: { text: string }
       Response: { success: boolean }

# ─── Session Management ─────────────────────────────────────────────────

POST   /api/v1/sessions
       Create a new agent session.

       Body: {
         agent: string,
         cli: 'claude' | 'codex' | 'gemini' | 'aider' | 'goose',
         task?: string,
         permissionMode?: 'auto' | 'plan' | 'manual',
         environment?: Record<string, string>
       }
       Response: {
         sessionId: string,
         agentName: string,
         status: 'starting' | 'ready'
       }

POST   /api/v1/sessions/:id/messages
       Send a message to an agent session.

       Body: { message: string }
       Response: { success: boolean, messageId: string }

GET    /api/v1/sessions/:id/events/sse
       Stream events via Server-Sent Events.
       (See Pillar 3)

DELETE /api/v1/sessions/:id
       End a session.

       Response: { success: boolean, summary: SessionSummary }
```

### Permission Detection in PTY

The wrapper's `OutputParser` already detects tool usage. We need to add detection for permission prompts:

```typescript
// Patterns to detect in agent output
const PERMISSION_PATTERNS = {
  claude: /Allow (.*?)\? \(y\/n\)/,
  codex: /Approve: (.*?) \[y\/n\]/,
  gemini: /Permission requested: (.*)/,
};
```

When detected:
1. Parser emits `permission.requested` event
2. Daemon holds the agent (doesn't inject 'y' or 'n')
3. External app receives the event via SSE or polls `/permissions`
4. External app calls `/approve` or `/deny`
5. Daemon injects the appropriate response into the PTY

### Permission Policies

Auto-approve rules to avoid blocking on low-risk operations:

```typescript
interface PermissionPolicy {
  tool: string;
  pattern?: string;         // Regex for command/path
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  action: 'auto-approve' | 'auto-deny' | 'require-human';
  timeout?: number;         // Auto-deny after ms
}

// Example default policy
const DEFAULT_POLICY: PermissionPolicy[] = [
  { tool: 'read',  action: 'auto-approve', riskLevel: 'low' },
  { tool: 'glob',  action: 'auto-approve', riskLevel: 'low' },
  { tool: 'grep',  action: 'auto-approve', riskLevel: 'low' },
  { tool: 'write', action: 'require-human', riskLevel: 'medium' },
  { tool: 'bash',  action: 'require-human', riskLevel: 'high' },
  { tool: 'bash',  pattern: /^(ls|pwd|git status|git log|git diff)/, action: 'auto-approve', riskLevel: 'low' },
  { tool: 'bash',  pattern: /rm|delete|drop|truncate/, action: 'require-human', riskLevel: 'critical' },
];
```

### Authentication

For production deployments, the HTTP API should support bearer token auth:

```
Authorization: Bearer <token>
```

Tokens configured via environment variable or config file:
```bash
export AGENT_RELAY_API_TOKEN=<your-token>
```

---

## 6. Pillar 3: SSE Event Streaming

### Why

Rivet's `/v1/sessions/{id}/events/sse` endpoint is the primary way external applications consume agent activity. We need an equivalent that streams our richer event schema.

### Endpoints

```
GET /api/v1/events/sse
    Stream all events across all agents.

    Query params:
      ?types=session.started,item.completed  (filter by event type)
      ?agent=Worker1                         (filter by agent)
      ?since=1707523200000                   (start from timestamp)
      ?offset=42                             (start from sequence number)

GET /api/v1/agents/:name/events/sse
    Stream events for a specific agent.

    Query params:
      ?types=...
      ?since=...
      ?offset=...

GET /api/v1/sessions/:id/events/sse
    Stream events for a specific session.

    Query params:
      ?types=...
      ?offset=...
```

### SSE Format

```
event: session.started
id: 1
data: {"type":"session.started","sessionId":"s_abc","agent":{"name":"Worker1","cli":"claude"},"startedAt":1707523200000,"config":{}}

event: item.started
id: 2
data: {"type":"item.started","sessionId":"s_abc","itemId":"i_001","itemType":"tool_call","startedAt":1707523201000}

event: item.delta
id: 3
data: {"type":"item.delta","sessionId":"s_abc","itemId":"i_001","delta":{"type":"tool_output","content":"File written successfully"}}

event: item.completed
id: 4
data: {"type":"item.completed","sessionId":"s_abc","itemId":"i_001","completedAt":1707523202000,"duration":1000}

event: permission.requested
id: 5
data: {"type":"permission.requested","sessionId":"s_abc","requestId":"p_001","tool":"bash","command":"rm -rf node_modules","description":"Delete node_modules directory","riskLevel":"high"}

event: message.exchanged
id: 6
data: {"type":"message.exchanged","sessionId":"s_abc","from":"Worker1","to":"Lead","body":"Task complete","kind":"message"}

: heartbeat

event: tokens.used
id: 7
data: {"type":"tokens.used","sessionId":"s_abc","agentName":"Worker1","model":"claude-sonnet-4-5-20250929","inputTokens":1500,"outputTokens":800,"estimatedCostUsd":0.012}
```

### Implementation

The SSE endpoints are implemented in the dashboard Express server:

```typescript
// In dashboard HTTP server
app.get('/api/v1/events/sse', authenticateRequest, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',    // Disable nginx buffering
  });

  const filters = parseEventFilters(req.query);
  const offset = parseInt(req.query.offset as string) || 0;

  // Replay from offset if requested
  if (offset > 0) {
    const historical = eventStore.query({ since: offset });
    for (const event of historical) {
      res.write(formatSSE(event));
    }
  }

  // Subscribe to live events
  const unsubscribe = eventBus.subscribe((event: AgentEvent, seq: number) => {
    if (matchesFilters(event, filters)) {
      res.write(`event: ${event.type}\nid: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  });

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});
```

### Last-Event-ID Support

Clients can reconnect and resume from the last received event:

```
GET /api/v1/events/sse
Last-Event-ID: 42
```

The server replays all events from sequence 42 onward before switching to live streaming.

---

## 7. Pillar 4: Orchestration Patterns as First-Class Features

### Why

Rivet has zero agent-to-agent coordination. This is our moat. But our current approach requires users to build patterns from raw messaging primitives. We should ship named, documented, one-line orchestration patterns.

### Pattern: Map-Reduce

Distribute work across N agents, then aggregate results.

```typescript
class RelayClient {
  patterns: {
    /**
     * Map-Reduce: Split work across agents, collect results.
     *
     * @example
     * const results = await client.patterns.mapReduce({
     *   task: 'Review these 5 files for security issues',
     *   items: ['auth.ts', 'db.ts', 'api.ts', 'routes.ts', 'middleware.ts'],
     *   workerCli: 'claude',
     *   maxWorkers: 3,
     *   timeout: 300000,
     * });
     */
    mapReduce<T, R>(options: MapReduceOptions<T>): Promise<MapReduceResult<R>>;
  };
}

interface MapReduceOptions<T> {
  /** Description of the overall task */
  task: string;

  /** Items to distribute across workers */
  items: T[];

  /** CLI to use for workers */
  workerCli: string;

  /** Max concurrent workers (default: items.length) */
  maxWorkers?: number;

  /** Template for individual work items. Use {{item}} placeholder. */
  itemTemplate?: string;

  /** Timeout per item in ms (default: 300000) */
  timeout?: number;

  /** Function to reduce results (default: collect into array) */
  reducer?: (results: unknown[]) => unknown;

  /** Retry failed items (default: 1) */
  retries?: number;
}

interface MapReduceResult<R> {
  results: R[];
  failures: Array<{ item: unknown; error: string }>;
  duration: number;
  workerCount: number;
  tokensUsed?: number;
}
```

**Implementation:** Uses `spawn()` to create worker agents, `sendAndWait()` for task assignment, and `release()` for cleanup. Workers are spawned in parallel up to `maxWorkers`, with a queue for remaining items.

### Pattern: Pipeline

Sequential processing through agent stages.

```typescript
interface PipelineOptions {
  /** Pipeline stages */
  stages: PipelineStage[];

  /** Initial input */
  input: string;

  /** Timeout per stage (default: 300000) */
  stageTimeout?: number;
}

interface PipelineStage {
  /** Stage name (used as agent name) */
  name: string;

  /** CLI to use */
  cli: string;

  /** Task template. {{input}} is replaced with previous stage output. */
  task: string;

  /** Optional validation before passing to next stage */
  validate?: (output: string) => boolean;
}

// Usage:
const result = await client.patterns.pipeline({
  input: 'Build a user authentication system',
  stages: [
    { name: 'Architect', cli: 'claude', task: 'Design the architecture for: {{input}}' },
    { name: 'Implementer', cli: 'codex', task: 'Implement this design: {{input}}' },
    { name: 'Reviewer', cli: 'gemini', task: 'Review this implementation: {{input}}' },
    { name: 'Tester', cli: 'claude', task: 'Write tests for: {{input}}' },
  ],
});
```

### Pattern: Supervisor

Auto-restart failed agents, reassign tasks, health monitoring.

```typescript
interface SupervisorOptions {
  /** Agents to supervise */
  agents: SupervisedAgent[];

  /** Health check interval (default: 30000) */
  healthCheckInterval?: number;

  /** Max restarts per agent (default: 3) */
  maxRestarts?: number;

  /** Action on repeated failure */
  onMaxRestarts?: 'escalate' | 'skip' | 'abort';

  /** Callback for health events */
  onHealthEvent?: (event: HealthEvent) => void;
}

interface SupervisedAgent {
  name: string;
  cli: string;
  task: string;
  role?: string;
  critical?: boolean;        // Abort all if this agent fails
}

// Usage:
const supervisor = await client.patterns.supervisor({
  agents: [
    { name: 'API', cli: 'claude', task: 'Build REST API', critical: true },
    { name: 'UI', cli: 'codex', task: 'Build frontend', critical: false },
    { name: 'Tests', cli: 'gemini', task: 'Write tests', critical: false },
  ],
  maxRestarts: 3,
  onMaxRestarts: 'escalate',
  onHealthEvent: (event) => console.log(event),
});

// Supervisor automatically:
// 1. Spawns all agents
// 2. Monitors health via heartbeat
// 3. Restarts crashed agents (up to maxRestarts)
// 4. Reassigns tasks from failed agents
// 5. Escalates to human on repeated failures

supervisor.stop(); // Cleanup
```

### Pattern: Fan-Out / Fan-In

Parallel execution with barrier synchronization.

```typescript
interface FanOutOptions {
  /** Tasks to execute in parallel */
  tasks: Array<{
    name: string;
    cli: string;
    task: string;
  }>;

  /** Wait for all or just first N */
  waitFor: 'all' | 'any' | number;

  /** Timeout for the entire fan-out */
  timeout?: number;
}

// Usage:
const results = await client.patterns.fanOut({
  tasks: [
    { name: 'Search-GitHub', cli: 'claude', task: 'Search GitHub for auth examples' },
    { name: 'Search-Docs', cli: 'codex', task: 'Search official docs for auth patterns' },
    { name: 'Search-SO', cli: 'gemini', task: 'Search StackOverflow for auth best practices' },
  ],
  waitFor: 'all',
  timeout: 120000,
});
```

### Pattern: Debate

Two agents argue for different approaches, a judge decides.

```typescript
interface DebateOptions {
  /** The question/decision to debate */
  question: string;

  /** Agent arguing for approach A */
  proponent: { cli: string; position: string };

  /** Agent arguing for approach B */
  opponent: { cli: string; position: string };

  /** Judge agent */
  judge: { cli: string; criteria: string };

  /** Number of rounds (default: 3) */
  rounds?: number;
}

// Usage:
const decision = await client.patterns.debate({
  question: 'Should we use PostgreSQL or MongoDB for this project?',
  proponent: { cli: 'claude', position: 'PostgreSQL is better because...' },
  opponent: { cli: 'codex', position: 'MongoDB is better because...' },
  judge: { cli: 'gemini', criteria: 'Evaluate based on: data model fit, scalability, team expertise' },
  rounds: 2,
});

// decision.winner: 'proponent' | 'opponent'
// decision.reasoning: string
// decision.transcript: DebateMessage[]
```

---

## 8. Pillar 5: OpenAPI Specification

### Why

Rivet ships a full OpenAPI spec enabling automatic client generation in any language. Our `docs/api/openapi.json` has schemas but no endpoints. Completing this enables Python, Go, Rust, Java clients without manual SDK work.

### Specification

Complete the existing OpenAPI spec with all endpoints from Pillar 2, plus existing dashboard endpoints:

```yaml
openapi: 3.1.0
info:
  title: Agent Relay API
  version: 3.0.0
  description: |
    Real-time multi-agent orchestration API. Control, monitor, and
    coordinate AI coding agents through a unified HTTP interface.

servers:
  - url: http://localhost:3888
    description: Local dashboard

security:
  - bearerAuth: []

paths:
  # Existing endpoints
  /api/health:
    get: ...
  /api/agents:
    get: ...
  /api/send:
    post: ...
  /api/spawn:
    post: ...
  /api/release:
    post: ...

  # New v1 endpoints (Pillar 2)
  /api/v1/sessions:
    post: ...
  /api/v1/sessions/{sessionId}/messages:
    post: ...
  /api/v1/sessions/{sessionId}/events/sse:
    get: ...
  /api/v1/agents/{name}/permissions:
    get: ...
  /api/v1/agents/{name}/permissions/{requestId}/approve:
    post: ...
  /api/v1/agents/{name}/permissions/{requestId}/deny:
    post: ...
  /api/v1/agents/{name}/questions:
    get: ...
  /api/v1/agents/{name}/questions/{questionId}/answer:
    post: ...
  /api/v1/agents/{name}/events/sse:
    get: ...
  /api/v1/events/sse:
    get: ...

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    AgentEvent: ...      # Full event schema
    AgentInfo: ...
    SessionSummary: ...
    PermissionRequest: ...
    # etc.
```

### Code Generation

```bash
# Generate TypeScript client
npx openapi-typescript-codegen \
  --input specs/openapi.yaml \
  --output packages/sdk/src/generated

# Generate Python client
openapi-python-client generate \
  --path specs/openapi.yaml \
  --output-path sdks/python/agent_relay
```

---

## 9. Pillar 6: Python SDK

### Why

Neither Relay nor Rivet has a Python SDK. The ML/AI engineer audience lives in Python. First mover captures this audience.

### Auto-Generated from OpenAPI

The SDK is generated from the OpenAPI spec (Pillar 5) with hand-written ergonomic wrappers.

### Package: `agent-relay`

```python
from agent_relay import RelayClient

# Connect to running daemon
client = RelayClient(base_url="http://localhost:3888")

# List agents
agents = client.list_agents()
for agent in agents:
    print(f"{agent.name} ({agent.cli}) - {agent.status}")

# Send message
client.send_message(to="Worker1", message="Review the auth module")

# Spawn agent
session = client.create_session(
    agent="Worker1",
    cli="claude",
    task="Implement user authentication",
    permission_mode="plan"
)

# Stream events
for event in client.stream_events(session_id=session.id):
    match event.type:
        case "item.started":
            print(f"Agent started: {event.item_type}")
        case "item.completed":
            print(f"Agent completed in {event.duration}ms")
        case "permission.requested":
            if event.risk_level in ("low", "medium"):
                client.approve_permission(
                    agent=session.agent_name,
                    request_id=event.request_id
                )
            else:
                print(f"HIGH RISK: {event.description}")
                # Human decides
        case "message.exchanged":
            print(f"{event['from']} -> {event.to}: {event.body}")
        case "tokens.used":
            print(f"Cost: ${event.estimated_cost_usd:.4f}")

# Orchestration patterns
from agent_relay.patterns import map_reduce

results = map_reduce(
    client,
    task="Review files for security issues",
    items=["auth.py", "db.py", "api.py"],
    worker_cli="claude",
    max_workers=3,
)
```

### Async Support

```python
import asyncio
from agent_relay import AsyncRelayClient

async def main():
    client = AsyncRelayClient(base_url="http://localhost:3888")

    async for event in client.stream_events():
        print(event)

asyncio.run(main())
```

### Distribution

```bash
pip install agent-relay
```

Published to PyPI. Requires Python 3.10+. Uses `httpx` for HTTP and `httpx-sse` for SSE streaming.

---

## 10. Pillar 7: Docker Container Isolation

### Why

Relay agents run with full host access locally. Rivet integrates with Docker MicroVMs, E2B Firecracker, and Daytona. For users who want sandboxed execution without our cloud, we need a local option.

### `--sandboxed` Flag

```bash
# Spawn an agent in a Docker container
agent-relay spawn Worker1 claude "Fix the auth bug" --sandboxed

# With custom limits
agent-relay spawn Worker1 claude "Fix the auth bug" \
  --sandboxed \
  --memory-limit 4g \
  --cpu-limit 2 \
  --network-mode none \
  --mount-readonly ./src
```

### Container Configuration

```typescript
interface SandboxConfig {
  enabled: boolean;

  /** Docker image (default: 'ghcr.io/agentworkforce/relay-sandbox:latest') */
  image?: string;

  /** Memory limit (default: '4g') */
  memoryLimit?: string;

  /** CPU limit (default: '2') */
  cpuLimit?: string;

  /** Network mode (default: 'none' for isolation) */
  networkMode?: 'none' | 'host' | 'bridge';

  /** Project directory mount mode */
  projectMount?: 'readwrite' | 'readonly' | 'copy';

  /** Additional volume mounts */
  volumes?: Array<{
    host: string;
    container: string;
    mode: 'ro' | 'rw';
  }>;

  /** Environment variables */
  env?: Record<string, string>;

  /** Security options */
  security?: {
    noNewPrivileges?: boolean;  // default: true
    readOnlyRootfs?: boolean;   // default: false
    dropCapabilities?: string[];
  };
}
```

### Sandbox Image

Minimal Docker image with:
- Node.js 22 (for relay-pty)
- relay-pty binary
- Common AI CLIs pre-installed (claude, codex)
- Git, common build tools
- Non-root user

```dockerfile
FROM node:22-slim

# Install relay-pty
COPY relay-pty /usr/local/bin/relay-pty

# Install AI CLIs
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Security
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /workspace

ENTRYPOINT ["relay-pty"]
```

### Communication

The containerized agent communicates with the host daemon via a mounted Unix socket:

```
Host:      ~/.agent-relay/relay.sock  (daemon)
Container: /tmp/agent-relay.sock       (mounted from host)
```

This preserves sub-5ms latency since communication stays local.

### Implementation

In the spawner package:

```typescript
async function spawnSandboxed(config: SpawnConfig & SandboxConfig): Promise<void> {
  const containerName = `relay-${config.name}-${Date.now()}`;

  const args = [
    'docker', 'run',
    '--name', containerName,
    '--rm',
    '--memory', config.memoryLimit || '4g',
    '--cpus', config.cpuLimit || '2',
    '--network', config.networkMode || 'none',
    '--security-opt', 'no-new-privileges',

    // Mount project directory
    '-v', `${config.projectDir}:/workspace:${config.projectMount || 'rw'}`,

    // Mount relay socket for daemon communication
    '-v', `${config.socketPath}:/tmp/agent-relay.sock`,

    // Mount outbox for file-based protocol
    '-v', `${config.outboxPath}:/tmp/agent-relay-outbox`,

    // Environment
    '-e', `AGENT_RELAY_OUTBOX=/tmp/agent-relay-outbox`,
    '-e', `AGENT_RELAY_SPAWNER=${config.spawner}`,

    config.image || 'ghcr.io/agentworkforce/relay-sandbox:latest',

    // relay-pty args
    '--socket', '/tmp/agent-relay.sock',
    '--agent', config.name,
    '--', config.cli, ...config.cliArgs,
  ];

  const process = spawn(args[0], args.slice(1));
  // ... lifecycle management
}
```

---

## 11. Pillar 8: Cost & Token Tracking

### Why

Neither Relay nor Rivet tracks costs. Enterprise buyers care deeply about "how much did this agent team cost me?" This is low-effort, high-value differentiation.

### Token Usage Parsing

Parse agent output for token usage stats. Each CLI prints usage differently:

```typescript
const TOKEN_PARSERS: Record<string, RegExp> = {
  // Claude Code: "Token usage: 1,500 input, 800 output (cache: 200 read, 100 write)"
  claude: /Token usage:\s*([\d,]+)\s*input,\s*([\d,]+)\s*output(?:\s*\(cache:\s*([\d,]+)\s*read,\s*([\d,]+)\s*write\))?/,

  // Codex: "Tokens: 1500 in / 800 out"
  codex: /Tokens:\s*([\d,]+)\s*in\s*\/\s*([\d,]+)\s*out/,

  // Gemini: "Usage: input_tokens=1500, output_tokens=800"
  gemini: /input_tokens\s*=\s*(\d+).*?output_tokens\s*=\s*(\d+)/,
};
```

### Cost Model

```typescript
interface CostModel {
  model: string;
  inputPer1M: number;        // USD per 1M input tokens
  outputPer1M: number;       // USD per 1M output tokens
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

const COST_MODELS: CostModel[] = [
  { model: 'claude-opus-4-6',           inputPer1M: 15.0,  outputPer1M: 75.0, cacheReadPer1M: 1.5,  cacheWritePer1M: 18.75 },
  { model: 'claude-sonnet-4-5-20250929', inputPer1M: 3.0,   outputPer1M: 15.0, cacheReadPer1M: 0.3,  cacheWritePer1M: 3.75 },
  { model: 'claude-haiku-4-5-20251001',  inputPer1M: 0.80,  outputPer1M: 4.0,  cacheReadPer1M: 0.08, cacheWritePer1M: 1.0 },
  { model: 'gpt-4o',                     inputPer1M: 2.5,   outputPer1M: 10.0 },
  { model: 'gpt-4o-mini',                inputPer1M: 0.15,  outputPer1M: 0.60 },
  { model: 'gemini-2.5-pro',             inputPer1M: 1.25,  outputPer1M: 10.0 },
  { model: 'gemini-2.5-flash',           inputPer1M: 0.15,  outputPer1M: 0.60 },
];
```

### Aggregation

```typescript
interface CostReport {
  /** Total across all agents */
  total: CostBreakdown;

  /** Per-agent breakdown */
  byAgent: Record<string, CostBreakdown>;

  /** Per-model breakdown */
  byModel: Record<string, CostBreakdown>;

  /** Per-session breakdown */
  bySession: Record<string, CostBreakdown>;

  /** Time series (5-minute buckets) */
  timeSeries: Array<{
    timestamp: number;
    cost: number;
    tokens: number;
  }>;
}

interface CostBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}
```

### API Endpoints

```
GET /api/v1/costs
    Get cost report for current project.

    Query params:
      ?since=...    (start timestamp)
      ?until=...    (end timestamp)
      ?agent=...    (filter by agent)
      ?session=...  (filter by session)

GET /api/v1/costs/realtime
    SSE stream of cost events as they occur.

GET /api/v1/costs/budget
    Get/set budget limits.

POST /api/v1/costs/budget
    Set budget limits.

    Body: {
      maxCostPerHour?: number,
      maxCostPerSession?: number,
      maxCostTotal?: number,
      alertThreshold?: number,  // 0-1, alert at this % of budget
      action: 'alert' | 'pause' | 'stop'
    }
```

### Dashboard Widget

The dashboard shows a real-time cost widget:
- Running total (USD)
- Per-agent cost bars
- Budget progress indicator
- Cost-per-minute trend line
- Alert when approaching budget

### Budget Enforcement

```typescript
interface BudgetConfig {
  /** Maximum cost per hour (USD) */
  maxPerHour?: number;

  /** Maximum cost per session (USD) */
  maxPerSession?: number;

  /** Maximum total cost (USD) */
  maxTotal?: number;

  /** Alert at this percentage of budget (0-1) */
  alertThreshold?: number;

  /** Action when budget exceeded */
  action: 'alert' | 'pause-spawning' | 'stop-all';
}
```

When budget is exceeded:
- `alert`: Emit `budget.exceeded` event, log warning
- `pause-spawning`: Block new `spawn()` calls
- `stop-all`: Gracefully release all worker agents

---

## 12. Pillar 9: ACP Compatibility Layer

### Why

Zed's Agent Client Protocol (ACP) is becoming the standard for editor-to-agent communication. JetBrains, Xcode, Neovim, and Emacs all support it. If Relay supports ACP, editors can use Relay-orchestrated agents natively.

**Positioning:** "ACP standardizes how you talk to one agent. Relay coordinates many."

### Architecture

```
┌──────────────────────────────────────────────────────┐
│                      Editor (Zed, JetBrains)          │
│                           │                           │
│                    ACP Protocol (stdio)               │
│                           │                           │
│              ┌────────────▼────────────┐              │
│              │   Relay ACP Bridge      │              │
│              │   (relay-acp binary)    │              │
│              └────────────┬────────────┘              │
│                           │                           │
│                  Unix Domain Socket                   │
│                           │                           │
│              ┌────────────▼────────────┐              │
│              │     Relay Daemon        │              │
│              │  (coordinates agents)   │              │
│              └────────────┬────────────┘              │
│                     ┌─────┴─────┐                     │
│                     │           │                     │
│                ┌────▼───┐ ┌────▼───┐                  │
│                │ Agent1 │ │ Agent2 │ ...               │
│                └────────┘ └────────┘                  │
└──────────────────────────────────────────────────────┘
```

### `relay-acp` Bridge Binary

A thin bridge that:
1. Accepts ACP JSON-RPC 2.0 over stdio (from editor)
2. Translates to Relay protocol over UDS (to daemon)
3. Translates Relay events back to ACP `session/update` notifications

### ACP Method Mapping

| ACP Method | Relay Equivalent |
|------------|------------------|
| `initialize` | HELLO/WELCOME handshake |
| `session/new` | Spawn lead agent + create session |
| `session/prompt` | SEND message to lead agent |
| `session/update` | Translate from AGENT_EVENT stream |
| `session/cancel` | Intervention (stop) |
| `session/request_permission` | Permission API (Pillar 2) |
| `fs/read_text_file` | Forward to agent's file read |
| `fs/write_text_file` | Forward to agent's file write |
| `terminal/create` | Spawn worker agent |

### Configuration

Users add to their editor settings:

**Zed:**
```json
{
  "agent": {
    "profiles": {
      "relay-team": {
        "binary": "relay-acp",
        "args": ["--project", "."],
        "name": "Agent Relay Team"
      }
    }
  }
}
```

**JetBrains:**
Install from ACP Agent Registry as "Agent Relay".

### Value Proposition

When a user selects "Agent Relay" as their ACP agent in Zed/JetBrains:
- A full team of agents is orchestrated behind the scenes
- The editor sees a single "agent" but Relay coordinates Lead, Workers, Reviewers
- Permission requests from any worker surface in the editor's UI
- All agent activity streams through the editor's chat panel

This is a fundamentally different experience from single-agent ACP adapters.

---

## 13. Pillar 10: OTel-Native Tracing Export

### Why

OpenTelemetry is becoming the standard for AI agent observability. The `TRACE_START`/`TRACE_EVENT`/`TRACE_END` messages in PRIMITIVES_ROADMAP.md already follow OTel's span model. We should align with OTel GenAI semantic conventions and export to Jaeger, Datadog, Grafana, etc.

### OTel GenAI Semantic Conventions Alignment

Map our events to OTel attributes:

```typescript
// OTel GenAI semantic conventions (from open-telemetry/semantic-conventions)
const OTEL_ATTRIBUTES = {
  // Agent identity
  'gen_ai.agent.name': 'Worker1',
  'gen_ai.agent.description': 'Backend implementer',

  // Task tracking
  'gen_ai.task.id': 'task_abc',
  'gen_ai.task.description': 'Implement user auth',
  'gen_ai.task.status': 'completed',

  // Model usage
  'gen_ai.request.model': 'claude-sonnet-4-5-20250929',
  'gen_ai.usage.input_tokens': 1500,
  'gen_ai.usage.output_tokens': 800,

  // Tool calls
  'gen_ai.tool.name': 'bash',
  'gen_ai.tool.call.id': 'tool_xyz',

  // Agent Relay specific (namespaced)
  'agent_relay.session.id': 's_abc',
  'agent_relay.message.from': 'Lead',
  'agent_relay.message.to': 'Worker1',
  'agent_relay.orchestration.pattern': 'map-reduce',
};
```

### Export Configuration

```typescript
interface OTelExportConfig {
  enabled: boolean;

  /** OTLP endpoint */
  endpoint: string;       // e.g., 'http://jaeger:4318/v1/traces'

  /** Protocol */
  protocol: 'http/json' | 'http/protobuf' | 'grpc';

  /** Service name */
  serviceName: string;    // default: 'agent-relay'

  /** Headers (e.g., for auth) */
  headers?: Record<string, string>;

  /** Sampling rate (0-1) */
  samplingRate?: number;

  /** What to export */
  export: {
    messages: boolean;     // Agent-to-agent messages as spans
    spawning: boolean;     // Agent lifecycle as spans
    toolCalls: boolean;    // Tool invocations as spans
    consensus: boolean;    // Consensus flows as spans
    patterns: boolean;     // Orchestration patterns as parent spans
  };
}
```

### Usage

```bash
# Enable OTel export via environment
export OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
export OTEL_SERVICE_NAME=agent-relay

agent-relay up --otel
```

```typescript
// Or via SDK
const client = new RelayClient({
  agentName: 'Lead',
  otel: {
    enabled: true,
    endpoint: 'http://jaeger:4318/v1/traces',
  },
});
```

### Trace Structure for Multi-Agent Workflows

```
Trace: "Implement user authentication" (pattern: map-reduce)
├── Span: Lead.plan (agent: Lead, tool: thinking)
├── Span: Lead.delegate (agent: Lead)
│   ├── Span: Worker1.spawn (agent: Worker1)
│   ├── Span: Worker1.execute (agent: Worker1)
│   │   ├── Span: tool_call:bash "npm install bcrypt" (4.2s)
│   │   ├── Span: tool_call:write "src/auth.ts" (0.8s)
│   │   └── Span: tool_call:bash "npm test" (12.1s)
│   ├── Span: Worker2.spawn (agent: Worker2)
│   └── Span: Worker2.execute (agent: Worker2)
│       ├── Span: tool_call:write "src/middleware.ts" (1.1s)
│       └── Span: tool_call:bash "npm test" (8.3s)
├── Span: Lead.aggregate (agent: Lead)
├── Span: Reviewer.spawn (agent: Reviewer)
└── Span: Reviewer.review (agent: Reviewer)
    ├── Span: tool_call:read "src/auth.ts" (0.1s)
    └── Span: tool_call:read "src/middleware.ts" (0.1s)
```

Each span carries `gen_ai.*` attributes, making the full multi-agent workflow visible in Jaeger/Grafana.

---

## 14. Dashboard Enhancements

The existing dashboard (relay-dashboard) should integrate with all new features:

### New Dashboard Panels

**1. Event Timeline**
- Visual timeline showing all ARES events across agents
- Filterable by event type, agent, time range
- Click event to see full payload
- Color-coded by event type

**2. Permission Queue**
- List of pending permission requests across all agents
- One-click approve/deny buttons
- Risk level badges (low/medium/high/critical)
- Auto-approve rules configuration

**3. Cost Dashboard**
- Real-time running total
- Per-agent cost breakdown (bar chart)
- Cost trend over time (line chart)
- Budget alerts and limits
- Session-level drill-down

**4. Orchestration Visualizer**
- Live visualization of active patterns (map-reduce, pipeline, etc.)
- Agent flow diagram showing message exchange
- Progress indicators per stage
- Duration and cost per stage

**5. Session Replay**
- Replay a completed session's event stream
- Scrub through timeline
- View file diffs at any point
- Export as shareable transcript

### API for External Dashboards

All dashboard data available via the REST API (Pillar 5) + SSE (Pillar 3), enabling:
- Custom dashboards built with any framework
- Grafana integration via JSON data source
- Slack/Discord bots that report cost and status
- CI/CD integration for automated agent workflows

---

## 15. Implementation Roadmap

### Phase 1: Competitive Parity (Weeks 1-4)

**Goal:** Match Rivet's developer ergonomics.

| Week | Deliverable | Pillar |
|------|-------------|--------|
| 1 | HTTP Permission API (approve/deny endpoints) | P2 |
| 1 | SSE event streaming (basic, messages only) | P3 |
| 2 | Universal Event Schema (types + parser integration) | P1 |
| 2 | SSE event streaming (full ARES events) | P3 |
| 3 | OpenAPI spec (complete with all endpoints) | P5 |
| 3 | Cost parsing (Claude, Codex output) | P8 |
| 4 | Python SDK (auto-generated from OpenAPI) | P6 |

**Exit criteria:** External web app can create a session, stream events, approve/deny permissions, and track costs — matching Rivet's core flow.

### Phase 2: Widen the Moat (Weeks 5-8)

**Goal:** Ship orchestration features Rivet can't match.

| Week | Deliverable | Pillar |
|------|-------------|--------|
| 5 | Map-Reduce pattern | P4 |
| 5 | Pipeline pattern | P4 |
| 6 | Fan-Out/Fan-In pattern | P4 |
| 6 | Supervisor pattern | P4 |
| 7 | Dashboard: Event Timeline + Permission Queue | P14 |
| 7 | Dashboard: Cost Dashboard | P14 |
| 8 | Dashboard: Orchestration Visualizer | P14 |
| 8 | Debate pattern | P4 |

**Exit criteria:** Users can run complex multi-agent workflows with one SDK call, with full visibility in the dashboard.

### Phase 3: Ecosystem Integration (Weeks 9-12)

**Goal:** Integrate with emerging standards.

| Week | Deliverable | Pillar |
|------|-------------|--------|
| 9 | OTel trace export | P10 |
| 9-10 | Docker container isolation | P7 |
| 11 | ACP bridge binary (relay-acp) | P9 |
| 11 | ACP Agent Registry listing | P9 |
| 12 | Budget enforcement | P8 |
| 12 | Session replay (dashboard) | P14 |

**Exit criteria:** Relay traces visible in Jaeger/Grafana, agents run in Docker sandbox, relay-acp listed in JetBrains/Zed agent registry.

### Phase 4: Refinement (Weeks 13-16)

| Week | Deliverable |
|------|-------------|
| 13-14 | Python SDK ergonomic improvements + documentation |
| 15 | Cost model updates, Gemini/Aider cost parsing |
| 16 | Performance benchmarks, load testing at 1000 agents |

---

## 16. What NOT to Do

### Don't Try to Be a Sandbox Provider
Relay uses Fly.io for cloud compute. Rivet abstracts over E2B/Daytona/Docker. Sandbox provisioning is a commodity race. Stay at the orchestration layer.

### Don't Drop the File-Based Protocol
It's quirky but it's why LLMs can use Relay without any SDK. Agents communicate by writing files, which LLMs do naturally. Rivet requires an external controller. Keep `$AGENT_RELAY_OUTBOX/msg` as the primary agent interface.

### Don't Rewrite in Rust
The Node.js dependency is friction, but a full rewrite is a 6-month project that produces no user-visible features. The relay-pty binary handles the performance-critical path. Optimize distribution instead (Docker image, brew formula, standalone binary via pkg).

### Don't Build a Sandbox Marketplace
E2B, Daytona, and Docker are the sandbox providers. Don't try to abstract over them. If users want sandboxed execution, point them to Docker isolation (Pillar 7) for local or our cloud for remote.

### Don't Chase Enterprise Features Prematurely
SOC 2, SSO/SAML, audit logs are important but not differentiating right now. Focus on the developer experience gap first.

### Don't Over-Index on A2A
Google's A2A protocol is enterprise-focused (batch tasks, long-running workflows). Relay is for real-time agent coordination. They're different markets. Monitor A2A but don't try to implement it.

---

## 17. Success Metrics

### Competitive Metrics

| Metric | Current | Target (3 months) | Target (6 months) |
|--------|---------|-------------------|-------------------|
| GitHub stars | ~current | +500 | +1500 |
| npm weekly downloads | ~current | 2x | 5x |
| PyPI weekly downloads | 0 | 200 | 1000 |
| ACP registry listing | No | Yes | Yes |
| OTel integration | No | Yes | Yes |

### Feature Parity with Rivet

| Feature | Rivet | Relay (current) | Relay (target) |
|---------|-------|-----------------|----------------|
| HTTP API | Full | Basic | Full (Phase 1) |
| Event schema | 8 types | None | 17+ types (Phase 1) |
| SSE streaming | Yes | No | Yes (Phase 1) |
| OpenAPI spec | Yes | Partial | Complete (Phase 1) |
| Permission API | Yes | Dashboard only | Full REST API (Phase 1) |
| Python SDK | No | No | Yes (Phase 1) |
| Agent-to-agent | No | Yes | Yes + patterns (Phase 2) |
| Orchestration | No | Primitives only | Named patterns (Phase 2) |
| OTel export | No | No | Yes (Phase 3) |
| Docker sandbox | Via providers | No | Yes (Phase 3) |
| ACP support | No | No | Yes (Phase 3) |

### Developer Experience Metrics

| Metric | Target |
|--------|--------|
| Time to "Hello World" (single agent via HTTP) | < 5 minutes |
| Time to "multi-agent workflow" (map-reduce) | < 15 minutes |
| API response latency (HTTP endpoints) | < 50ms p99 |
| SSE event latency (event to client) | < 100ms p99 |
| Python SDK install to first event | < 3 minutes |

---

## Appendix A: Rivet Sandbox Agent Feature Matrix

Detailed mapping of every Rivet feature to our response:

| Rivet Feature | Our Response | Priority |
|---------------|-------------|----------|
| `POST /v1/sessions/{id}` | `POST /api/v1/sessions` | P0 |
| `POST /v1/sessions/{id}/messages` | `POST /api/v1/sessions/:id/messages` | P0 |
| `GET /v1/sessions/{id}/events/sse` | `GET /api/v1/sessions/:id/events/sse` | P0 |
| Universal session schema (8 events) | ARES schema (17+ events) | P0 |
| Permission approve/deny over HTTP | `/permissions/:id/approve\|deny` | P0 |
| OpenAPI spec | Complete spec with codegen | P1 |
| Inspector UI | Event Timeline + Session Replay | P2 |
| Embedded mode (TypeScript) | Already supported via SDK | - |
| Server mode (HTTP) | Already supported via dashboard | - |
| Auto agent installation | Not needed (agents pre-installed) | - |
| Gigacode (experimental TUI) | Not competing here | - |

## Appendix B: Standards Alignment

| Standard | Our Position | Action |
|----------|-------------|--------|
| **ACP** (Zed/JetBrains) | Complementary — ACP is editor-to-agent, we are agent-to-agent | Build relay-acp bridge (Pillar 9) |
| **A2A** (Google) | Different market — enterprise batch vs real-time coding | Monitor, don't implement |
| **OTel GenAI** | Aligned — adopt semantic conventions for tracing | Export traces (Pillar 10) |
| **AGNTCY** (Cisco) | Too early — spec-stage, 65+ orgs but no production usage | Monitor only |
| **ANP** | Irrelevant — internet-scale agent discovery, not local coordination | Ignore |
| **MCP** (Anthropic) | Complementary — we already have MCP server support | Maintain |

## Appendix C: Event Schema Compatibility

Rivet's events mapped to ARES:

| Rivet Event | ARES Event | Notes |
|-------------|------------|-------|
| `session.started` | `session.started` | 1:1 mapping |
| `session.ended` | `session.ended` | 1:1 mapping |
| `item.started` | `item.started` | 1:1 mapping |
| `item.delta` | `item.delta` | 1:1 mapping |
| `item.completed` | `item.completed` | 1:1 mapping |
| `permission.requested` | `permission.requested` | ARES adds riskLevel |
| `permission.resolved` | `permission.resolved` | ARES adds resolvedBy |
| `question.requested` | `question.requested` | 1:1 mapping |
| `question.resolved` | `question.resolved` | ARES adds resolvedBy |
| (not supported) | `message.exchanged` | Relay exclusive |
| (not supported) | `agent.spawned` | Relay exclusive |
| (not supported) | `agent.released` | Relay exclusive |
| (not supported) | `consensus.proposed` | Relay exclusive |
| (not supported) | `consensus.resolved` | Relay exclusive |
| (not supported) | `tokens.used` | Relay exclusive |
| (not supported) | `file.operation` | Relay exclusive |
| (not supported) | `command.executed` | Relay exclusive |
