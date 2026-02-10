# Agent Relay v3.0 — Hardened Implementation Spec

**Status:** Draft
**Date:** 2026-02-10
**Scope:** Pillars 1–6 only (competitive parity + orchestration moat)
**Prerequisite:** [COMPETITIVE_STRATEGY.md](./COMPETITIVE_STRATEGY.md)

---

## Scope Boundary

**v3.0 ships Pillars 1–6.** Pillars 7–10 (Docker isolation, ACP bridge, OTel export, budget enforcement) are deferred to v3.1. This spec is the implementation contract for v3.0.

**Out of scope for this spec:**
- Docker container isolation
- ACP compatibility layer
- OTel trace export
- Budget enforcement (cost *tracking* is in scope, budget *enforcement* is not)

---

## 1. Universal Agent Event Schema (ARES v1)

### 1.1 Goal

Normalize all agent activity into a typed event stream. Superset of Rivet's 8 event types, adding 9 Relay-exclusive types.

### 1.2 New Package: `@agent-relay/events`

Create `packages/events/` with:

```
packages/events/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Re-exports
    ├── types.ts              # All event interfaces + union type
    ├── event-bus.ts          # In-process pub/sub for events
    ├── event-store.ts        # JSONL persistence (read/write/query)
    ├── event-emitter.ts      # Bridges OutputParser → EventBus
    └── serialization.ts      # JSON serialization helpers
```

### 1.3 Type Definitions

File: `packages/events/src/types.ts`

17 event types in 4 groups:

| Group | Events | Source |
|-------|--------|--------|
| Session lifecycle | `session.started`, `session.ended` | SpawnManager (`packages/daemon/src/spawn-manager.ts`) |
| Agent activity | `item.started`, `item.delta`, `item.completed` | OutputParser (`packages/wrapper/src/parser.ts`) |
| Human-in-the-loop | `permission.requested`, `permission.resolved`, `question.requested`, `question.resolved` | OutputParser (new detection patterns) |
| Relay-exclusive | `message.exchanged`, `agent.spawned`, `agent.released`, `consensus.proposed`, `consensus.resolved`, `tokens.used`, `file.operation`, `command.executed` | Router, SpawnManager, OutputParser |

Every event carries a common envelope:

```typescript
interface AgentEventEnvelope {
  _seq: number;          // Monotonic sequence number
  _ts: number;           // Unix ms (event creation time)
  _sessionId: string;    // Session that produced this event
  _agentName: string;    // Agent that produced this event
}
```

Event interfaces extend this envelope. Full type definitions match the COMPETITIVE_STRATEGY.md schema (lines 103–337).

### 1.4 EventBus

File: `packages/events/src/event-bus.ts`

```typescript
class EventBus {
  private seq = 0;
  private subscribers: Set<(event: AgentEvent, seq: number) => void>;

  /** Publish an event. Assigns _seq and _ts. */
  publish(event: AgentEvent): number;

  /** Subscribe to events. Returns unsubscribe function. */
  subscribe(
    fn: (event: AgentEvent, seq: number) => void,
    filter?: EventFilter
  ): () => void;

  /** Get current sequence number */
  getSeq(): number;
}

interface EventFilter {
  types?: AgentEvent['type'][];
  agents?: string[];
  sessionIds?: string[];
}
```

The EventBus is instantiated once in the Daemon and passed to:
- `DaemonApi` (for SSE streaming — Pillar 3)
- `EventStore` (for persistence)
- `Router` (for message.exchanged events)
- `SpawnManager` (for agent.spawned/released and session.* events)

### 1.5 EventStore

File: `packages/events/src/event-store.ts`

Persists events to JSONL at `~/.agent-relay/projects/{hash}/events.jsonl`.

```typescript
class EventStore {
  constructor(projectDir: string, eventBus: EventBus);

  /** Auto-subscribes to EventBus and appends events */
  start(): void;
  stop(): void;

  /** Query historical events */
  query(options: EventQueryOptions): AgentEvent[];

  /** Get events since a sequence number (for SSE replay) */
  since(seq: number, filter?: EventFilter): AgentEvent[];
}
```

Uses append-only writes with `fs.appendFileSync` for durability. Reads use line-by-line streaming to avoid loading full history into memory.

### 1.6 Integration Points

**OutputParser changes** (`packages/wrapper/src/parser.ts`):

Add detection patterns for permission and question prompts:

```typescript
const PERMISSION_PATTERNS: Record<string, RegExp> = {
  claude: /(?:Allow|Approve)\s+(.+?)\?\s*\(?[Yy]\/[Nn]\)?/,
  codex: /Approve:\s*(.+?)\s*\[y\/n\]/,
  gemini: /Permission requested:\s*(.+)/,
};

const QUESTION_PATTERNS: Record<string, RegExp> = {
  claude: /\?\s*\(.*\)\s*$/m,
  codex: /\?\s*\[.*\]\s*$/m,
};
```

The parser emits events by calling `eventBus.publish()` when it detects:
- Tool call start → `item.started`
- Tool output chunks → `item.delta`
- Tool call completion → `item.completed`
- Permission prompts → `permission.requested`
- Questions → `question.requested`
- Token usage lines → `tokens.used`
- File operations → `file.operation`
- Bash commands → `command.executed`

**Token parsing patterns** (new, added to parser):

```typescript
const TOKEN_PATTERNS: Record<string, RegExp> = {
  claude: /(\d[\d,]*)\s*input.*?(\d[\d,]*)\s*output/,
  codex: /Tokens:\s*(\d[\d,]*)\s*in\s*\/\s*(\d[\d,]*)\s*out/,
  gemini: /input_tokens\s*=\s*(\d+).*?output_tokens\s*=\s*(\d+)/,
};
```

**Router changes** (`packages/daemon/src/router.ts`):

After routing any `SEND` / `CHANNEL_MESSAGE` / `DELIVER`, emit:

```typescript
eventBus.publish({
  type: 'message.exchanged',
  sessionId: /* derive from agent's session */,
  from: envelope.from,
  to: envelope.to,
  body: envelope.payload.body,
  kind: envelope.payload.kind || 'message',
  thread: envelope.payload.thread,
  channel: envelope.topic,
});
```

**SpawnManager changes** (`packages/daemon/src/spawn-manager.ts`):

On spawn success → `session.started` + `agent.spawned`
On release → `agent.released` + `session.ended`

### 1.7 Protocol Extension

Add `AGENT_EVENT` to `MessageType` in `packages/protocol/src/types.ts`:

```typescript
| 'AGENT_EVENT'
```

Payload:
```typescript
interface AgentEventPayload {
  event: AgentEvent;
}
```

Direction: Daemon → subscribed clients (broadcast to all connected SDK clients). This allows SDK consumers to receive events over the existing socket protocol as well as SSE.

### 1.8 Acceptance Criteria

- [ ] All 17 event types defined with TypeScript interfaces
- [ ] EventBus pub/sub works with filtering
- [ ] EventStore persists to JSONL and supports replay from sequence number
- [ ] OutputParser emits `item.*` events for tool calls detected in Claude, Codex, Gemini output
- [ ] OutputParser detects permission prompts for Claude and Codex (Gemini if pattern is confirmed)
- [ ] OutputParser parses token usage from Claude output
- [ ] Router emits `message.exchanged` for all routed messages
- [ ] SpawnManager emits `session.*` and `agent.*` lifecycle events
- [ ] `AGENT_EVENT` protocol message broadcasts events to SDK clients
- [ ] Events stored in `events.jsonl` with monotonic `_seq`

---

## 2. HTTP Control & Permission API

### 2.1 Goal

Expose REST endpoints for session management, permission approval/denial, and agent control. External web apps can drive agent workflows without building a dashboard.

### 2.2 Where

All new endpoints added to `packages/daemon/src/api.ts` in the existing `DaemonApi.setupRoutes()` method, using the existing `this.routes.set()` pattern.

New routes use `/api/v1/` prefix to version them separately from existing `/` routes.

### 2.3 Endpoints

#### Session Management

```
POST   /api/v1/sessions
```

Creates a new agent session. Delegates to SpawnManager.

Request body:
```json
{
  "agent": "string (required — agent name)",
  "cli": "claude | codex | gemini | aider | goose (required)",
  "task": "string (optional — initial task prompt)",
  "cwd": "string (optional — working directory)"
}
```

Response `201`:
```json
{
  "sessionId": "string",
  "agentName": "string",
  "status": "starting"
}
```

Implementation: Call `this.spawnManager.handleSpawn()` with a synthesized `SPAWN` envelope, return the session ID from the `SPAWN_RESULT`.

```
POST   /api/v1/sessions/:sessionId/messages
```

Send a message/prompt to an agent session.

Request body:
```json
{
  "message": "string (required)"
}
```

Response `200`:
```json
{
  "success": true,
  "messageId": "string"
}
```

Implementation: Look up agent by sessionId, call `SpawnManager.handleSendInput()` to write to the agent's PTY.

```
DELETE /api/v1/sessions/:sessionId
```

End a session (release the agent).

Response `200`:
```json
{
  "success": true,
  "summary": { "duration": 12345, "itemCount": 42 }
}
```

#### Permission Management

```
GET    /api/v1/agents/:name/permissions
```

List pending permission requests for an agent.

Response `200`:
```json
{
  "permissions": [{
    "requestId": "string",
    "tool": "string",
    "command": "string | null",
    "filePath": "string | null",
    "description": "string",
    "riskLevel": "low | medium | high | critical",
    "requestedAt": 1234567890
  }]
}
```

```
POST   /api/v1/agents/:name/permissions/:requestId/approve
POST   /api/v1/agents/:name/permissions/:requestId/deny
```

Approve or deny a permission request.

Request body:
```json
{
  "reason": "string (optional)"
}
```

Response `200`:
```json
{
  "success": true
}
```

Implementation: When a `permission.requested` event fires, the daemon stores it in a `PendingPermissions` map keyed by `requestId`. The approve/deny endpoints:
1. Look up the pending request
2. Write `y\n` or `n\n` to the agent's PTY via `SpawnManager.handleSendInput()`
3. Emit `permission.resolved` event
4. Remove from pending map

#### Question/Answer

```
GET    /api/v1/agents/:name/questions
POST   /api/v1/agents/:name/questions/:questionId/answer
```

Same pattern as permissions. Pending questions stored in a `PendingQuestions` map. Answer endpoint writes the answer text to the agent's PTY.

#### Agent Control

```
POST   /api/v1/agents/:name/pause
POST   /api/v1/agents/:name/resume
POST   /api/v1/agents/:name/stop
POST   /api/v1/agents/:name/input
```

- **pause**: Sets a flag that prevents message injection into the agent's PTY. Queues incoming messages.
- **resume**: Flushes queued messages into PTY.
- **stop**: Calls `SpawnManager.handleRelease()`.
- **input**: Raw PTY input via `SpawnManager.handleSendInput()`.

### 2.4 New Internal Component: PermissionManager

File: `packages/daemon/src/permission-manager.ts`

```typescript
class PermissionManager {
  private pending: Map<string, PendingPermission>;
  private policies: PermissionPolicy[];

  constructor(eventBus: EventBus, spawnManager: SpawnManager);

  /** Called when OutputParser detects a permission prompt */
  onPermissionDetected(agentName: string, tool: string, description: string): string; // returns requestId

  /** Approve a pending request */
  approve(requestId: string, reason?: string): boolean;

  /** Deny a pending request */
  deny(requestId: string, reason?: string): boolean;

  /** Get pending permissions for an agent */
  getPending(agentName: string): PendingPermission[];

  /** Evaluate auto-approve policies */
  private evaluatePolicy(tool: string, command?: string): 'auto-approve' | 'auto-deny' | 'require-human';
}
```

Default policies (configurable via `~/.agent-relay/config.json`):
- `read`, `glob`, `grep` → auto-approve
- `bash` with `ls|pwd|git status|git log|git diff` → auto-approve
- `bash` with `rm|delete|drop|truncate` → require-human, risk=critical
- Everything else → require-human

### 2.5 Authentication

Bearer token auth, optional. When `AGENT_RELAY_API_TOKEN` env var is set, all `/api/v1/*` requests require:

```
Authorization: Bearer <token>
```

Implemented as middleware in `DaemonApi.handleRequest()` — check before route dispatch. Return `401` if token is set but request doesn't match.

When no token is set, all requests are allowed (local development mode).

### 2.6 Acceptance Criteria

- [ ] `POST /api/v1/sessions` spawns an agent and returns sessionId
- [ ] `POST /api/v1/sessions/:id/messages` sends text to agent PTY
- [ ] `DELETE /api/v1/sessions/:id` releases agent and returns summary
- [ ] `GET /api/v1/agents/:name/permissions` returns pending permission requests
- [ ] `POST .../approve` writes `y` to PTY, emits `permission.resolved`
- [ ] `POST .../deny` writes `n` to PTY, emits `permission.resolved`
- [ ] Question endpoints work same pattern
- [ ] `/pause` queues messages, `/resume` flushes them
- [ ] `/stop` gracefully releases agent
- [ ] `/input` writes raw text to PTY
- [ ] Bearer token auth enforced when env var is set
- [ ] All endpoints return proper HTTP status codes (201 for creation, 404 for not found, 401 for unauth)

---

## 3. SSE Event Streaming

### 3.1 Goal

Stream ARES events to external consumers via Server-Sent Events. Supports filtering, replay from sequence number, and reconnection via `Last-Event-ID`.

### 3.2 Endpoints

```
GET /api/v1/events/sse                      — All events, all agents
GET /api/v1/agents/:name/events/sse         — Events for one agent
GET /api/v1/sessions/:sessionId/events/sse  — Events for one session
```

Query params (all optional):
- `types` — Comma-separated event type filter: `?types=item.started,item.completed`
- `since` — Start from Unix ms timestamp: `?since=1707523200000`
- `offset` — Start from sequence number: `?offset=42`

Header support:
- `Last-Event-ID: 42` — Replay from sequence 42 (same as `?offset=42`)

### 3.3 Implementation

In `packages/daemon/src/api.ts`, add a special handler for SSE routes. The existing route system returns `{ status, body }` objects which get serialized — SSE needs to hold the connection open.

Add an `sseRoutes` map alongside `routes`:

```typescript
private sseRoutes: Map<string, (req: IncomingMessage, res: ServerResponse) => void> = new Map();
```

In `handleRequest()`, check `sseRoutes` first for matching paths.

SSE handler pattern:

```typescript
this.sseRoutes.set('GET /api/v1/events/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const filters = parseFiltersFromQuery(req);
  const startSeq = getStartSeq(req); // from ?offset= or Last-Event-ID header

  // 1. Replay historical events if requested
  if (startSeq > 0) {
    const historical = this.eventStore.since(startSeq, filters);
    for (const [event, seq] of historical) {
      writeSSE(res, event, seq);
    }
  }

  // 2. Subscribe to live events
  const unsub = this.eventBus.subscribe((event, seq) => {
    writeSSE(res, event, seq);
  }, filters);

  // 3. Heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30_000);

  // 4. Cleanup on disconnect
  req.on('close', () => {
    unsub();
    clearInterval(heartbeat);
  });
});
```

SSE wire format:
```
event: item.started
id: 42
data: {"type":"item.started","sessionId":"s_abc",...}

```

Helper:
```typescript
function writeSSE(res: ServerResponse, event: AgentEvent, seq: number): void {
  res.write(`event: ${event.type}\nid: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
}
```

### 3.4 Acceptance Criteria

- [ ] `GET /api/v1/events/sse` streams all events as SSE
- [ ] `GET /api/v1/agents/:name/events/sse` filters to one agent
- [ ] `GET /api/v1/sessions/:id/events/sse` filters to one session
- [ ] `?types=` filter works
- [ ] `?offset=` replays historical events then switches to live
- [ ] `Last-Event-ID` header works for reconnection
- [ ] Heartbeat sent every 30s
- [ ] Connection cleanup on client disconnect (no leaked subscriptions)
- [ ] CORS headers applied (same as existing API)

---

## 4. Orchestration Patterns

### 4.1 Goal

Ship named, documented orchestration patterns as SDK methods. Users get complex multi-agent workflows with one function call.

### 4.2 Where

New file: `packages/sdk/src/patterns.ts`

Exported from `packages/sdk/src/index.ts`.

### 4.3 Scope for v3.0

Ship 3 patterns. Defer Debate to v3.1 (needs user validation).

| Pattern | Priority | Ships in v3.0? |
|---------|----------|----------------|
| Map-Reduce | P1 | Yes |
| Pipeline | P1 | Yes |
| Fan-Out / Fan-In | P1 | Yes |
| Supervisor | P2 | Deferred — complex, needs real-world usage data |
| Debate | P2 | Deferred — demo feature, unvalidated demand |

### 4.4 Pattern: Map-Reduce

Distribute N work items across up to M workers, collect results.

```typescript
interface MapReduceOptions<T> {
  /** Overall task description (used in worker prompts) */
  task: string;

  /** Items to distribute */
  items: T[];

  /** CLI for workers */
  workerCli: string;

  /** Max concurrent workers (default: items.length, max: 10) */
  maxWorkers?: number;

  /** Template for per-item prompt. {{item}} and {{task}} replaced. */
  itemTemplate?: string;

  /** Timeout per item in ms (default: 300_000) */
  timeout?: number;

  /** Retries per failed item (default: 1) */
  retries?: number;
}

interface MapReduceResult<R> {
  results: Array<{ item: unknown; result: R }>;
  failures: Array<{ item: unknown; error: string; attempts: number }>;
  duration: number;
  workerCount: number;
}
```

Implementation:

```typescript
async function mapReduce<T, R>(
  client: RelayClient,
  options: MapReduceOptions<T>
): Promise<MapReduceResult<R>> {
  const maxWorkers = Math.min(options.maxWorkers ?? options.items.length, 10);
  const queue = [...options.items];
  const results: MapReduceResult<R>['results'] = [];
  const failures: MapReduceResult<R>['failures'] = [];
  const start = Date.now();
  let workerIndex = 0;

  // Process queue with worker pool
  async function processItem(item: T): Promise<void> {
    const name = `MapWorker-${++workerIndex}`;
    const prompt = (options.itemTemplate ?? '{{task}}\n\nWork on: {{item}}')
      .replace('{{task}}', options.task)
      .replace('{{item}}', String(item));

    let attempts = 0;
    const maxAttempts = (options.retries ?? 1) + 1;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        await client.spawn(name, options.workerCli, prompt, true);
        const response = await client.request(name, 'Report your result as a single JSON object.', {
          timeout: options.timeout ?? 300_000,
        });
        results.push({ item, result: JSON.parse(response.body) as R });
        await client.release(name);
        return;
      } catch (err) {
        await client.release(name).catch(() => {});
        if (attempts >= maxAttempts) {
          failures.push({ item, error: (err as Error).message, attempts });
        }
      }
    }
  }

  // Run pool
  const pool: Promise<void>[] = [];
  for (const item of queue) {
    if (pool.length >= maxWorkers) {
      await Promise.race(pool);
    }
    const p = processItem(item).then(() => {
      pool.splice(pool.indexOf(p), 1);
    });
    pool.push(p);
  }
  await Promise.all(pool);

  return { results, failures, duration: Date.now() - start, workerCount: workerIndex };
}
```

### 4.5 Pattern: Pipeline

Sequential processing through named stages. Output of each stage becomes input to the next.

```typescript
interface PipelineOptions {
  /** Pipeline stages in order */
  stages: PipelineStage[];

  /** Initial input text */
  input: string;

  /** Timeout per stage in ms (default: 300_000) */
  stageTimeout?: number;
}

interface PipelineStage {
  /** Stage name (used as agent name) */
  name: string;

  /** CLI for this stage */
  cli: string;

  /** Task template. {{input}} replaced with previous stage output. */
  task: string;
}

interface PipelineResult {
  /** Final output */
  output: string;

  /** Per-stage results */
  stages: Array<{
    name: string;
    input: string;
    output: string;
    duration: number;
  }>;

  /** Total duration */
  duration: number;
}
```

Implementation: Spawn stage 1 with `input`, await response, release, spawn stage 2 with stage 1's output, repeat.

### 4.6 Pattern: Fan-Out / Fan-In

Parallel execution with configurable completion strategy.

```typescript
interface FanOutOptions {
  /** Tasks to execute in parallel */
  tasks: Array<{
    name: string;
    cli: string;
    task: string;
  }>;

  /** Completion strategy */
  waitFor: 'all' | 'any' | number;

  /** Timeout for the entire fan-out in ms (default: 300_000) */
  timeout?: number;
}

interface FanOutResult {
  completed: Array<{ name: string; result: string; duration: number }>;
  pending: string[];
  duration: number;
}
```

Implementation: Spawn all agents in parallel, use `Promise.all` / `Promise.race` / `Promise.allSettled` depending on `waitFor`. Release all agents on completion or timeout.

### 4.7 SDK Surface

```typescript
// packages/sdk/src/patterns.ts
export { mapReduce, type MapReduceOptions, type MapReduceResult } from './patterns/map-reduce.js';
export { pipeline, type PipelineOptions, type PipelineResult } from './patterns/pipeline.js';
export { fanOut, type FanOutOptions, type FanOutResult } from './patterns/fan-out.js';

// packages/sdk/src/index.ts
export * as patterns from './patterns.js';
```

Usage:
```typescript
import { RelayClient, patterns } from '@agent-relay/sdk';

const client = new RelayClient({ agentName: 'Orchestrator' });
await client.connect();

const results = await patterns.mapReduce(client, {
  task: 'Review file for security issues',
  items: ['auth.ts', 'db.ts', 'api.ts'],
  workerCli: 'claude',
  maxWorkers: 3,
});
```

### 4.8 Acceptance Criteria

- [ ] `mapReduce()` spawns workers, distributes items, collects results, releases workers
- [ ] `mapReduce()` respects `maxWorkers` concurrency limit
- [ ] `mapReduce()` retries failed items up to `retries` count
- [ ] `pipeline()` runs stages sequentially, passing output forward
- [ ] `fanOut()` runs tasks in parallel with `waitFor: 'all'`
- [ ] `fanOut()` completes early with `waitFor: 'any'`
- [ ] `fanOut()` completes when N tasks finish with `waitFor: number`
- [ ] All patterns clean up (release) agents on success, failure, and timeout
- [ ] All patterns have TypeScript types exported from SDK

---

## 5. OpenAPI Specification

### 5.1 Goal

Complete OpenAPI 3.1.0 spec covering all existing dashboard routes + all new v1 routes. Enable automatic client generation.

### 5.2 Where

Generated from Zod schemas in `packages/api-types/src/schemas/` using the existing `generate:openapi` script.

Output: `docs/api/openapi.json`

### 5.3 New Schemas to Add

In `packages/api-types/src/schemas/`:

```
schemas/
├── index.ts                # Existing — add new exports
├── agent.ts                # Existing
├── message.ts              # Existing
├── session.ts              # NEW — session create/delete schemas
├── permission.ts           # NEW — permission request/response schemas
├── question.ts             # NEW — question request/response schemas
├── event.ts                # NEW — agent event schemas (all 17 types)
├── cost.ts                 # NEW — cost/token schemas
└── control.ts              # NEW — pause/resume/stop/input schemas
```

### 5.4 Endpoints to Document

All existing routes from `DaemonApi.setupRoutes()`:

```
GET    /                                    — Health check
GET    /metrics                             — Prometheus metrics
GET    /workspaces                          — List workspaces
POST   /workspaces                          — Create workspace
GET    /workspaces/:id                      — Get workspace
DELETE /workspaces/:id                      — Delete workspace
POST   /workspaces/:id/switch               — Switch workspace
GET    /workspaces/:id/agents               — List agents in workspace
POST   /workspaces/:id/agents               — Spawn agent in workspace
GET    /agents                              — List all agents
GET    /agents/:id                          — Get agent details
DELETE /agents/:id                          — Stop agent
GET    /agents/:id/output                   — Get agent output
POST   /agents/:id/input                    — Send input to agent
POST   /agents/:id/interrupt                — Interrupt agent
POST   /agents/by-name/:name/interrupt      — Interrupt by name
```

All new v1 routes from Pillar 2:

```
POST   /api/v1/sessions                     — Create session
POST   /api/v1/sessions/:id/messages        — Send message
DELETE /api/v1/sessions/:id                  — End session
GET    /api/v1/agents/:name/permissions      — List pending permissions
POST   /api/v1/agents/:name/permissions/:id/approve
POST   /api/v1/agents/:name/permissions/:id/deny
GET    /api/v1/agents/:name/questions        — List pending questions
POST   /api/v1/agents/:name/questions/:id/answer
POST   /api/v1/agents/:name/pause
POST   /api/v1/agents/:name/resume
POST   /api/v1/agents/:name/stop
POST   /api/v1/agents/:name/input
GET    /api/v1/events/sse                    — SSE stream (all events)
GET    /api/v1/agents/:name/events/sse       — SSE stream (one agent)
GET    /api/v1/sessions/:id/events/sse       — SSE stream (one session)
GET    /api/v1/costs                         — Cost report
```

### 5.5 Security Scheme

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: Set via AGENT_RELAY_API_TOKEN env var. Optional for local development.
```

### 5.6 Generation

Update `packages/api-types/scripts/generate-openapi.ts` to:
1. Register all new Zod schemas with `@asteasolutions/zod-to-openapi`
2. Define all route paths with request/response schemas
3. Output to `docs/api/openapi.json`

### 5.7 Acceptance Criteria

- [ ] All existing dashboard routes documented with request/response schemas
- [ ] All new v1 routes documented
- [ ] SSE endpoints documented (noting `text/event-stream` content type)
- [ ] Security scheme defined
- [ ] `npm run generate:openapi` in `api-types` produces valid OpenAPI 3.1.0
- [ ] Generated spec validates with `swagger-cli validate`
- [ ] Spec is usable with `openapi-typescript-codegen` for TS client generation
- [ ] Spec is usable with `openapi-python-client` for Python client generation

---

## 6. Cost & Token Tracking

### 6.1 Goal

Parse token usage from agent output, compute estimated costs, expose via API. No budget enforcement in v3.0 (deferred to v3.1).

### 6.2 Where

Token parsing: `packages/wrapper/src/parser.ts` (extend existing parsing)
Cost computation: `packages/events/src/cost.ts` (new file)
API: `packages/daemon/src/api.ts` (new endpoint)

### 6.3 Token Parsing

Add to OutputParser — detect and parse token usage lines from each CLI:

| CLI | Pattern | Example |
|-----|---------|---------|
| Claude | `/(\d[\d,]*)\s*input.*?(\d[\d,]*)\s*output/` | "Token usage: 1,500 input, 800 output" |
| Codex | `/Tokens:\s*(\d[\d,]*)\s*in\s*\/\s*(\d[\d,]*)\s*out/` | "Tokens: 1500 in / 800 out" |
| Gemini | `/input_tokens\s*=\s*(\d+).*?output_tokens\s*=\s*(\d+)/` | "Usage: input_tokens=1500, output_tokens=800" |

On match, emit `tokens.used` event via EventBus.

### 6.4 Cost Model

File: `packages/events/src/cost.ts`

```typescript
interface CostModel {
  model: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

/** Updatable cost table. Loaded from config, falls back to hardcoded defaults. */
function loadCostModels(): CostModel[];

/** Compute cost for a tokens.used event */
function computeCost(event: TokenUsageEvent, models: CostModel[]): number;
```

Cost models loaded from `~/.agent-relay/cost-models.json` if present, otherwise hardcoded defaults. This avoids the cost table rotting — users/CI can update the file.

### 6.5 Cost Aggregation

File: `packages/events/src/cost-aggregator.ts`

Subscribes to `tokens.used` events, maintains running totals:

```typescript
class CostAggregator {
  constructor(eventBus: EventBus, costModels: CostModel[]);

  /** Get cost report */
  getReport(options?: { since?: number; until?: number; agent?: string }): CostReport;
}

interface CostReport {
  total: CostBreakdown;
  byAgent: Record<string, CostBreakdown>;
  byModel: Record<string, CostBreakdown>;
}

interface CostBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}
```

### 6.6 API Endpoint

```
GET /api/v1/costs
```

Query params:
- `since` — Unix ms timestamp
- `until` — Unix ms timestamp
- `agent` — Filter by agent name

Response `200`:
```json
{
  "total": { "inputTokens": 15000, "outputTokens": 8000, "totalTokens": 23000, "estimatedCostUsd": 0.234 },
  "byAgent": { "Worker1": { ... }, "Worker2": { ... } },
  "byModel": { "claude-sonnet-4-5-20250929": { ... } }
}
```

### 6.7 Acceptance Criteria

- [ ] Token usage parsed from Claude Code output
- [ ] Token usage parsed from Codex output (if pattern confirmed)
- [ ] `tokens.used` events emitted with correct token counts
- [ ] Cost computed using configurable cost models
- [ ] `GET /api/v1/costs` returns aggregated cost report
- [ ] Cost report filterable by agent and time range
- [ ] Cost models loadable from `~/.agent-relay/cost-models.json`
- [ ] Fallback to hardcoded defaults when config file absent

---

## Implementation Order

Dependency graph:

```
Pillar 1 (Events) ──┬──→ Pillar 3 (SSE)
                     ├──→ Pillar 6 (Costs) ──→ Cost API endpoint
                     └──→ Pillar 2 (HTTP API)
                                              ↘
Pillar 5 (OpenAPI) ←── depends on Pillar 2 + 3 being finalized
Pillar 4 (Patterns) ── independent, depends only on existing SDK
```

### Phase 1: Foundation (Weeks 1–2)

| Week | Work | Pillar |
|------|------|--------|
| 1 | `@agent-relay/events` package: types, EventBus, EventStore | 1 |
| 1 | OutputParser integration: `item.*` events from tool call detection | 1 |
| 2 | Permission detection in OutputParser + PermissionManager | 1, 2 |
| 2 | Token usage parsing in OutputParser | 1, 6 |

### Phase 2: HTTP Surface (Weeks 3–4)

| Week | Work | Pillar |
|------|------|--------|
| 3 | Session management endpoints (`POST/DELETE /sessions`, `POST /messages`) | 2 |
| 3 | Permission endpoints (list/approve/deny) | 2 |
| 3 | Agent control endpoints (pause/resume/stop/input) | 2 |
| 4 | SSE streaming endpoints (all 3 paths) with replay | 3 |
| 4 | Bearer token auth | 2 |

### Phase 3: SDK & Spec (Weeks 5–6)

| Week | Work | Pillar |
|------|------|--------|
| 5 | Cost aggregator + `GET /api/v1/costs` endpoint | 6 |
| 5 | Map-Reduce pattern | 4 |
| 5 | Pipeline pattern | 4 |
| 6 | Fan-Out pattern | 4 |
| 6 | OpenAPI spec generation (all endpoints) | 5 |

### Phase 4: Hardening (Weeks 7–8)

| Week | Work |
|------|------|
| 7 | Integration tests: end-to-end SSE streaming with real agents |
| 7 | Integration tests: permission flow (detect → hold → approve → resume) |
| 8 | Load testing: 100 concurrent SSE connections, 10 agents |
| 8 | Documentation: migration guide from Rivet, API reference |

---

## Open Questions

1. **Permission detection accuracy.** The regex patterns for detecting permission prompts need validation against real agent output. Allocate spike time in Week 2 to capture and test against actual Claude/Codex permission prompt formats.

2. **Token parsing reliability.** Claude Code's token output format may vary between versions. Consider parsing from the JSON structured output if available, falling back to regex.

3. **SSE connection limits.** Need to decide max concurrent SSE connections per daemon. Suggest 100 as default, configurable.

4. **Event retention.** How long to keep `events.jsonl`? Suggest 7-day rolling window with configurable retention.

5. **Pattern result format.** Map-Reduce asks workers to "report result as JSON" — this is fragile. May need structured output parsing or a convention for result extraction.
