# Agent Relay: New Primitives Specification

This document specifies new primitives to enhance Agent Relay's competitive position against frameworks like OpenAI Agents SDK, LangGraph, CrewAI, and others.

## Table of Contents

1. [Memory System](#1-memory-system)
2. [Guardrails](#2-guardrails)
3. [Tracing & Observability](#3-tracing--observability)
4. [Human-in-the-Loop](#4-human-in-the-loop)
5. [Backpressure & Flow Control](#5-backpressure--flow-control)
6. [Attachments](#6-attachments)
7. [Roles & Permissions](#7-roles--permissions)
8. [Task Queues](#8-task-queues)

---

## 1. Memory System

### Overview

A structured memory system enabling agents to store, retrieve, and share knowledge across sessions and between agents. Competitors (LangGraph, CrewAI) offer sophisticated memory; we currently only have inbox + state payloads.

### Memory Types

| Type | Scope | Persistence | Use Case |
|------|-------|-------------|----------|
| **Short-term** | Thread/session | In-memory | Current conversation context |
| **Long-term** | Cross-session | SQLite/Postgres | User preferences, learned facts |
| **Entity** | Global | Database | People, concepts, relationships |
| **Shared** | Multi-agent | Daemon-managed | Coordination state |

### Protocol Messages

#### MEMORY_SET

Store a value in memory.

```typescript
interface MemorySetPayload {
  key: string;              // Namespaced key: "user:preferences", "entity:alice"
  value: unknown;           // JSON-serializable value
  scope: MemoryScope;       // 'short-term' | 'long-term' | 'entity' | 'shared'
  ttl?: number;             // Time-to-live in ms (optional)
  tags?: string[];          // Tags for filtering/search
  embedding?: boolean;      // Generate vector embedding for semantic search
}

type MemoryScope = 'short-term' | 'long-term' | 'entity' | 'shared';
```

**Envelope:**
```json
{
  "v": 1,
  "type": "MEMORY_SET",
  "id": "uuid",
  "ts": 1737900000000,
  "from": "WorkerAgent",
  "payload": {
    "key": "user:preferences",
    "value": { "theme": "dark", "language": "en" },
    "scope": "long-term",
    "ttl": 86400000,
    "tags": ["user", "settings"]
  }
}
```

#### MEMORY_GET

Retrieve a value from memory.

```typescript
interface MemoryGetPayload {
  key: string;
  scope?: MemoryScope;      // If omitted, search all scopes
}

interface MemoryGetResponsePayload {
  key: string;
  value: unknown | null;
  scope: MemoryScope;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  createdBy: string;        // Agent that created this memory
}
```

#### MEMORY_SEARCH

Semantic search across memories (requires embeddings).

```typescript
interface MemorySearchPayload {
  query: string;            // Natural language query
  scope?: MemoryScope;
  tags?: string[];          // Filter by tags
  limit?: number;           // Max results (default: 10)
  threshold?: number;       // Similarity threshold (0-1)
}

interface MemorySearchResponsePayload {
  results: Array<{
    key: string;
    value: unknown;
    score: number;          // Similarity score
    scope: MemoryScope;
  }>;
}
```

#### MEMORY_DELETE

Remove a memory entry.

```typescript
interface MemoryDeletePayload {
  key: string;
  scope?: MemoryScope;
}
```

#### MEMORY_LIST

List memory keys matching a pattern.

```typescript
interface MemoryListPayload {
  pattern?: string;         // Glob pattern: "user:*", "entity:person:*"
  scope?: MemoryScope;
  tags?: string[];
  limit?: number;
  offset?: number;
}

interface MemoryListResponsePayload {
  keys: Array<{
    key: string;
    scope: MemoryScope;
    updatedAt: number;
    size: number;           // Approximate size in bytes
  }>;
  total: number;
}
```

### SDK API

```typescript
class RelayClient {
  // Memory namespace
  memory: {
    // Basic operations
    set(key: string, value: unknown, options?: MemorySetOptions): Promise<void>;
    get<T = unknown>(key: string, scope?: MemoryScope): Promise<T | null>;
    delete(key: string, scope?: MemoryScope): Promise<boolean>;
    list(options?: MemoryListOptions): Promise<MemoryKey[]>;

    // Semantic search (requires embedding support)
    search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;

    // Convenience methods
    getOrSet<T>(key: string, factory: () => T | Promise<T>, options?: MemorySetOptions): Promise<T>;
    increment(key: string, delta?: number): Promise<number>;
    append(key: string, value: unknown): Promise<void>;

    // Namespaced helpers
    user: MemoryNamespace;    // Scoped to current user/agent
    shared: MemoryNamespace;  // Shared across all agents
    entities: EntityMemory;   // Entity-specific operations
  };
}

interface MemorySetOptions {
  scope?: MemoryScope;
  ttl?: number;
  tags?: string[];
  embedding?: boolean;
}

interface EntityMemory {
  // Entity-specific operations
  track(type: string, id: string, attributes: Record<string, unknown>): Promise<void>;
  get(type: string, id: string): Promise<Entity | null>;
  find(type: string, query: Record<string, unknown>): Promise<Entity[]>;
  relate(entity1: EntityRef, relation: string, entity2: EntityRef): Promise<void>;
  getRelated(entity: EntityRef, relation: string): Promise<Entity[]>;
}
```

### Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Memory Manager                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Short-term  │  │  Long-term  │  │      Entities       │  │
│  │   Cache     │  │   Store     │  │       Store         │  │
│  │  (In-mem)   │  │  (SQLite)   │  │  (SQLite + Vector)  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│         │                │                    │              │
│         └────────────────┴────────────────────┘              │
│                          │                                   │
│                   ┌──────▼──────┐                           │
│                   │   Vector    │  (Optional: for search)   │
│                   │   Index     │                           │
│                   └─────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

### Database Schema

```sql
-- Long-term and entity memory
CREATE TABLE memory (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,  -- 'short-term', 'long-term', 'entity', 'shared'
  value TEXT NOT NULL,  -- JSON
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  tags TEXT,  -- JSON array
  embedding BLOB,  -- Vector embedding for semantic search
  UNIQUE(key, scope)
);

CREATE INDEX idx_memory_scope ON memory(scope);
CREATE INDEX idx_memory_key_prefix ON memory(key);
CREATE INDEX idx_memory_expires ON memory(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_memory_tags ON memory(tags);

-- Entity relationships
CREATE TABLE entity_relations (
  id TEXT PRIMARY KEY,
  entity1_type TEXT NOT NULL,
  entity1_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  entity2_type TEXT NOT NULL,
  entity2_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,  -- JSON
  UNIQUE(entity1_type, entity1_id, relation, entity2_type, entity2_id)
);
```

### Configuration

```typescript
interface MemoryConfig {
  enabled: boolean;
  storage: 'memory' | 'sqlite' | 'postgres';

  shortTerm: {
    maxSize: number;        // Max entries (default: 1000)
    defaultTtl: number;     // Default TTL in ms (default: 3600000 = 1hr)
  };

  longTerm: {
    maxSize: number;        // Max entries (default: 100000)
    defaultTtl?: number;    // Optional default TTL
    pruneInterval: number;  // Cleanup interval (default: 3600000)
  };

  embedding: {
    enabled: boolean;
    provider: 'openai' | 'local' | 'none';
    model?: string;         // e.g., 'text-embedding-3-small'
    dimensions?: number;    // Vector dimensions
  };
}
```

### Usage Examples

```typescript
// Store user preference
await client.memory.set('user:theme', 'dark', {
  scope: 'long-term',
  tags: ['preferences']
});

// Get with fallback
const theme = await client.memory.getOrSet('user:theme', () => 'light');

// Track an entity
await client.memory.entities.track('person', 'alice', {
  name: 'Alice',
  role: 'developer',
  skills: ['typescript', 'rust']
});

// Create relationship
await client.memory.entities.relate(
  { type: 'person', id: 'alice' },
  'works-with',
  { type: 'person', id: 'bob' }
);

// Semantic search (with embeddings enabled)
const results = await client.memory.search(
  'What are Alice\'s programming skills?',
  { scope: 'entity', limit: 5 }
);

// Shared state across agents
await client.memory.shared.set('project:status', {
  phase: 'implementation',
  completedTasks: 5,
  totalTasks: 12
});
```

---

## 2. Guardrails

### Overview

Input/output validation and safety checks that run before processing and before delivery. Essential for production deployments.

### Guardrail Types

| Type | When | Purpose |
|------|------|---------|
| **Input** | Before processing incoming message | Validate/sanitize user input |
| **Output** | Before sending message | Validate/filter agent output |
| **Tool** | Before tool execution | Validate tool parameters |
| **Action** | Before state changes | Validate proposed actions |

### Protocol Messages

#### GUARDRAIL_REGISTER

Register a guardrail with the daemon.

```typescript
interface GuardrailRegisterPayload {
  id: string;               // Unique guardrail ID
  type: GuardrailType;      // 'input' | 'output' | 'tool' | 'action'
  name: string;             // Human-readable name
  priority: number;         // Execution order (lower = first)
  config: GuardrailConfig;
}

type GuardrailType = 'input' | 'output' | 'tool' | 'action';

interface GuardrailConfig {
  // Rule-based checks (fast, no LLM)
  rules?: GuardrailRule[];

  // LLM-based checks (slower, semantic)
  llmCheck?: {
    enabled: boolean;
    prompt: string;
    model?: string;
  };

  // External webhook
  webhook?: {
    url: string;
    timeout: number;
  };

  // Built-in validators
  builtIn?: BuiltInGuardrail[];
}

interface GuardrailRule {
  type: 'regex' | 'length' | 'contains' | 'schema' | 'custom';
  params: Record<string, unknown>;
  action: 'block' | 'warn' | 'sanitize';
  message?: string;
}

type BuiltInGuardrail =
  | 'pii-detection'
  | 'profanity-filter'
  | 'jailbreak-detection'
  | 'sql-injection'
  | 'prompt-injection'
  | 'code-execution'
  | 'url-validation'
  | 'json-schema';
```

#### GUARDRAIL_RESULT

Result of guardrail check (used internally and for logging).

```typescript
interface GuardrailResultPayload {
  guardrailId: string;
  messageId: string;
  passed: boolean;
  action: 'allow' | 'block' | 'sanitize' | 'warn';
  reason?: string;
  sanitizedContent?: string;  // If sanitized
  duration: number;           // Check duration in ms
}
```

### SDK API

```typescript
class RelayClient {
  guardrails: {
    // Register guardrails
    register(guardrail: GuardrailDefinition): Promise<void>;
    unregister(id: string): Promise<void>;
    list(): Promise<GuardrailInfo[]>;

    // Manual validation (for testing)
    validate(content: string, type: GuardrailType): Promise<ValidationResult>;

    // Built-in validators (client-side, fast)
    validators: {
      pii: PIIValidator;
      profanity: ProfanityValidator;
      schema: SchemaValidator;
      length: LengthValidator;
    };
  };
}

interface GuardrailDefinition {
  id: string;
  name: string;
  type: GuardrailType;
  priority?: number;

  // Sync validator (fast, runs inline)
  validate?: (content: string, context: GuardrailContext) => ValidationResult;

  // Async validator (can call external services)
  validateAsync?: (content: string, context: GuardrailContext) => Promise<ValidationResult>;

  // Built-in checks
  rules?: GuardrailRule[];
  builtIn?: BuiltInGuardrail[];
}

interface ValidationResult {
  passed: boolean;
  action: 'allow' | 'block' | 'sanitize' | 'warn';
  reason?: string;
  sanitized?: string;
  metadata?: Record<string, unknown>;
}

interface GuardrailContext {
  from: string;
  to: string;
  type: 'input' | 'output';
  messageId: string;
  thread?: string;
}
```

### Built-in Guardrails

```typescript
// PII Detection
interface PIIDetectorConfig {
  types: ('email' | 'phone' | 'ssn' | 'credit_card' | 'ip_address' | 'name')[];
  action: 'block' | 'redact' | 'warn';
  redactWith?: string;  // Default: '[REDACTED]'
}

// Profanity Filter
interface ProfanityFilterConfig {
  level: 'strict' | 'moderate' | 'mild';
  customWords?: string[];
  action: 'block' | 'censor' | 'warn';
}

// Schema Validator
interface SchemaValidatorConfig {
  schema: JSONSchema;
  action: 'block' | 'warn';
}

// Length Validator
interface LengthValidatorConfig {
  minLength?: number;
  maxLength?: number;
  action: 'block' | 'truncate' | 'warn';
}

// Jailbreak Detection
interface JailbreakDetectorConfig {
  sensitivity: 'high' | 'medium' | 'low';
  patterns?: string[];  // Additional regex patterns
  action: 'block' | 'warn';
}
```

### Daemon Integration

Guardrails run in the daemon's message pipeline:

```
Message Received
       │
       ▼
┌──────────────────┐
│  Input Guardrails │ ← Block/sanitize before processing
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Route Message   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Output Guardrails│ ← Block/sanitize before delivery
└────────┬─────────┘
         │
         ▼
    Deliver Message
```

### Configuration

```typescript
interface GuardrailsConfig {
  enabled: boolean;

  // Default guardrails applied to all messages
  defaults: {
    input: BuiltInGuardrail[];
    output: BuiltInGuardrail[];
  };

  // Fail-open or fail-closed
  onError: 'allow' | 'block';

  // Timeout for async validators
  timeout: number;  // Default: 5000ms

  // Logging
  logBlocked: boolean;
  logWarnings: boolean;
}
```

### Usage Examples

```typescript
// Register PII detection guardrail
await client.guardrails.register({
  id: 'pii-blocker',
  name: 'PII Detection',
  type: 'output',
  priority: 1,
  builtIn: ['pii-detection'],
  rules: [
    {
      type: 'regex',
      params: { pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },  // SSN
      action: 'block',
      message: 'Message contains SSN'
    }
  ]
});

// Custom validation logic
await client.guardrails.register({
  id: 'custom-validator',
  name: 'Business Rules',
  type: 'output',
  validate: (content, context) => {
    if (content.includes('password') && context.to !== 'SecurityAgent') {
      return {
        passed: false,
        action: 'block',
        reason: 'Cannot share password info with non-security agents'
      };
    }
    return { passed: true, action: 'allow' };
  }
});

// Schema validation for structured messages
await client.guardrails.register({
  id: 'task-schema',
  name: 'Task Format Validator',
  type: 'input',
  rules: [{
    type: 'schema',
    params: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          status: { enum: ['pending', 'complete', 'blocked'] }
        },
        required: ['taskId', 'status']
      }
    },
    action: 'block'
  }]
});
```

---

## 3. Tracing & Observability

### Overview

Deep workflow tracing with step-by-step visibility, compatible with OpenTelemetry standards.

### Trace Structure

```
Trace (root span)
├── Span: receive-message
│   ├── Span: input-guardrails
│   └── Span: route-to-agent
├── Span: agent-processing
│   ├── Span: tool-call-1
│   ├── Span: tool-call-2
│   └── Span: generate-response
├── Span: output-guardrails
└── Span: deliver-message
```

### Protocol Messages

#### TRACE_START

Start a new trace or span.

```typescript
interface TraceStartPayload {
  traceId: string;          // Root trace ID
  spanId: string;           // This span's ID
  parentSpanId?: string;    // Parent span (if nested)
  name: string;             // Span name
  kind: SpanKind;           // 'internal' | 'client' | 'server' | 'producer' | 'consumer'
  attributes?: Record<string, SpanAttributeValue>;
}

type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer';
type SpanAttributeValue = string | number | boolean | string[] | number[];
```

#### TRACE_EVENT

Add an event to a span.

```typescript
interface TraceEventPayload {
  traceId: string;
  spanId: string;
  name: string;
  timestamp: number;
  attributes?: Record<string, SpanAttributeValue>;
}
```

#### TRACE_END

End a span.

```typescript
interface TraceEndPayload {
  traceId: string;
  spanId: string;
  status: SpanStatus;
  endTime: number;
  attributes?: Record<string, SpanAttributeValue>;
}

interface SpanStatus {
  code: 'ok' | 'error' | 'unset';
  message?: string;
}
```

#### TRACE_QUERY

Query traces.

```typescript
interface TraceQueryPayload {
  traceId?: string;         // Get specific trace
  agent?: string;           // Filter by agent
  since?: number;           // Start time
  until?: number;           // End time
  status?: 'ok' | 'error';  // Filter by status
  minDuration?: number;     // Min duration in ms
  limit?: number;
}

interface TraceQueryResponsePayload {
  traces: TraceInfo[];
  total: number;
}

interface TraceInfo {
  traceId: string;
  rootSpan: SpanInfo;
  spans: SpanInfo[];
  startTime: number;
  endTime: number;
  duration: number;
  status: SpanStatus;
  agentCount: number;
}

interface SpanInfo {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime: number;
  duration: number;
  status: SpanStatus;
  attributes: Record<string, SpanAttributeValue>;
  events: SpanEvent[];
}
```

### SDK API

```typescript
class RelayClient {
  tracing: {
    // Start a new trace
    startTrace(name: string, attributes?: Record<string, SpanAttributeValue>): Trace;

    // Get current trace context
    currentTrace(): Trace | null;

    // Query historical traces
    query(options: TraceQueryOptions): Promise<TraceInfo[]>;

    // Export to OpenTelemetry
    exportOTLP(endpoint: string): void;
  };
}

interface Trace {
  traceId: string;

  // Span management
  startSpan(name: string, options?: SpanOptions): Span;
  currentSpan(): Span | null;

  // End the trace
  end(status?: SpanStatus): void;

  // Context propagation
  getContext(): TraceContext;
}

interface Span {
  spanId: string;

  // Add events
  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): void;

  // Set attributes
  setAttribute(key: string, value: SpanAttributeValue): void;
  setAttributes(attributes: Record<string, SpanAttributeValue>): void;

  // Record exceptions
  recordException(error: Error): void;

  // Set status
  setStatus(status: SpanStatus): void;

  // End span
  end(): void;
}

interface TraceContext {
  traceId: string;
  spanId: string;
  // W3C Trace Context format
  traceparent: string;
  tracestate?: string;
}
```

### OpenTelemetry Integration

```typescript
// Export traces to OTLP endpoint
client.tracing.exportOTLP('http://jaeger:4318/v1/traces');

// Or use collector
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const exporter = new OTLPTraceExporter({
  url: 'http://collector:4318/v1/traces'
});

client.tracing.setExporter(exporter);
```

### Auto-Instrumentation

The daemon automatically traces:

```typescript
interface AutoInstrumentationConfig {
  enabled: boolean;

  // What to trace automatically
  instrument: {
    messages: boolean;        // All message send/receive
    spawning: boolean;        // Agent spawn/release
    consensus: boolean;       // Proposal/vote flows
    channels: boolean;        // Channel operations
    memory: boolean;          // Memory operations
    guardrails: boolean;      // Guardrail checks
  };

  // Sampling
  sampling: {
    rate: number;             // 0.0 - 1.0 (default: 1.0)
    alwaysSampleErrors: boolean;
  };

  // Attributes to include
  includePayload: boolean;    // Include message body (privacy concern)
  maxPayloadSize: number;     // Truncate large payloads
}
```

### Database Schema

```sql
CREATE TABLE traces (
  trace_id TEXT PRIMARY KEY,
  root_span_id TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  status TEXT,
  agent_count INTEGER DEFAULT 1
);

CREATE TABLE spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES traces(trace_id),
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  duration INTEGER,
  status_code TEXT,
  status_message TEXT,
  attributes TEXT,  -- JSON
  FOREIGN KEY (parent_span_id) REFERENCES spans(span_id)
);

CREATE TABLE span_events (
  id TEXT PRIMARY KEY,
  span_id TEXT NOT NULL REFERENCES spans(span_id),
  name TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  attributes TEXT  -- JSON
);

CREATE INDEX idx_traces_time ON traces(start_time);
CREATE INDEX idx_spans_trace ON spans(trace_id);
CREATE INDEX idx_spans_parent ON spans(parent_span_id);
```

### Usage Examples

```typescript
// Manual tracing
const trace = client.tracing.startTrace('process-user-request', {
  'user.id': 'alice',
  'request.type': 'feature'
});

const parseSpan = trace.startSpan('parse-intent');
parseSpan.setAttribute('intent', 'add-authentication');
parseSpan.end();

const delegateSpan = trace.startSpan('delegate-to-workers');
delegateSpan.addEvent('spawning-worker', { name: 'BackendWorker' });

await client.spawn({ name: 'BackendWorker', cli: 'claude', task: '...' });
delegateSpan.addEvent('worker-spawned');

// ... worker completes

delegateSpan.end();
trace.end({ code: 'ok' });

// Query traces
const traces = await client.tracing.query({
  agent: 'Lead',
  since: Date.now() - 3600000,
  minDuration: 1000  // Only slow operations
});
```

---

## 4. Human-in-the-Loop

### Overview

Primitives for involving humans in agent workflows: approvals, escalations, and interventions.

### Protocol Messages

#### APPROVAL_REQUEST

Request approval from a human or designated agent.

```typescript
interface ApprovalRequestPayload {
  id: string;                 // Approval request ID
  action: string;             // What needs approval
  description: string;        // Human-readable description
  requester: string;          // Agent requesting approval
  approvers: string[];        // Who can approve
  data?: unknown;             // Contextual data
  timeout?: number;           // Auto-reject after ms
  minApprovals?: number;      // Required approval count (default: 1)
  allowDelegation?: boolean;  // Can approvers delegate?
}
```

#### APPROVAL_RESPONSE

Respond to an approval request.

```typescript
interface ApprovalResponsePayload {
  requestId: string;
  approved: boolean;
  approver: string;
  reason?: string;
  delegateTo?: string;        // If delegating
}
```

#### APPROVAL_RESULT

Final result of approval process.

```typescript
interface ApprovalResultPayload {
  requestId: string;
  status: 'approved' | 'rejected' | 'timeout' | 'delegated';
  approvals: Array<{
    approver: string;
    approved: boolean;
    reason?: string;
    timestamp: number;
  }>;
}
```

#### ESCALATION

Escalate an issue to a human or supervisor.

```typescript
interface EscalationPayload {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  type: 'error' | 'decision' | 'stuck' | 'safety' | 'custom';
  summary: string;
  details: string;
  context?: unknown;
  escalateTo: string[];       // Who to notify
  requiresAction: boolean;    // Needs response or just FYI
}
```

#### INTERVENTION

Human intervention in an agent's workflow.

```typescript
interface InterventionPayload {
  targetAgent: string;
  type: 'pause' | 'resume' | 'stop' | 'redirect' | 'inject';
  reason: string;
  data?: unknown;             // For 'redirect' or 'inject'
}
```

### SDK API

```typescript
class RelayClient {
  hitl: {
    // Request approval (blocks until resolved)
    requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;

    // Non-blocking approval request
    submitApprovalRequest(request: ApprovalRequest): string;  // Returns request ID
    getApprovalStatus(requestId: string): Promise<ApprovalResult | null>;

    // Respond to approval requests
    approve(requestId: string, reason?: string): Promise<void>;
    reject(requestId: string, reason?: string): Promise<void>;
    delegate(requestId: string, to: string): Promise<void>;

    // Listen for approval requests (for human agents)
    onApprovalRequest?: (request: ApprovalRequest) => void;

    // Escalation
    escalate(escalation: Escalation): Promise<string>;
    onEscalation?: (escalation: Escalation) => void;

    // Intervention (for supervisors)
    intervene(intervention: Intervention): Promise<void>;
    onIntervention?: (intervention: Intervention) => void;
  };
}

interface ApprovalRequest {
  action: string;
  description: string;
  approvers: string[];
  data?: unknown;
  timeout?: number;
  minApprovals?: number;
}

interface ApprovalResult {
  requestId: string;
  status: 'approved' | 'rejected' | 'timeout';
  approvals: ApprovalRecord[];
}
```

### Dashboard Integration

The dashboard shows:

1. **Pending Approvals** - List of approval requests awaiting response
2. **Escalation Queue** - Active escalations by severity
3. **Intervention Controls** - Pause/stop/redirect buttons for each agent
4. **Approval History** - Past approvals with audit trail

### Usage Examples

```typescript
// Request approval before deployment
const approval = await client.hitl.requestApproval({
  action: 'deploy-to-production',
  description: 'Deploy v1.2.3 to production environment',
  approvers: ['Human', 'Lead'],
  data: {
    version: '1.2.3',
    changes: ['Feature A', 'Bug fix B'],
    testsPassed: true
  },
  timeout: 300000,  // 5 minutes
  minApprovals: 2
});

if (approval.status === 'approved') {
  await deployToProduction();
} else {
  console.log('Deployment rejected:', approval.approvals);
}

// Escalate a stuck situation
await client.hitl.escalate({
  severity: 'medium',
  type: 'stuck',
  summary: 'Cannot resolve merge conflict',
  details: 'File src/auth.ts has conflicts that require human decision',
  escalateTo: ['Human', 'Lead'],
  requiresAction: true
});

// Human agent listening for approvals
client.hitl.onApprovalRequest = async (request) => {
  console.log(`Approval needed: ${request.action}`);
  // Show in UI, get human input
  const decision = await promptHuman(request);

  if (decision.approved) {
    await client.hitl.approve(request.id, decision.reason);
  } else {
    await client.hitl.reject(request.id, decision.reason);
  }
};

// Supervisor intervention
await client.hitl.intervene({
  targetAgent: 'RogueWorker',
  type: 'stop',
  reason: 'Agent is in infinite loop'
});
```

---

## 5. Backpressure & Flow Control

### Overview

Prevent message loss under load with bounded queues, priority lanes, and flow control signals.

### Protocol Messages

#### BUSY

Signal that an agent cannot accept more messages.

```typescript
interface BusyPayload {
  agent: string;
  queueDepth: number;
  estimatedWait: number;      // Estimated ms until ready
  acceptPriority?: number;    // Only accept messages above this priority
}
```

#### READY

Signal that an agent can accept messages again.

```typescript
interface ReadyPayload {
  agent: string;
  queueDepth: number;
}
```

#### NACK (Enhanced)

Negative acknowledgment with reason.

```typescript
interface NackPayload {
  messageId: string;
  reason: NackReason;
  retryAfter?: number;        // Suggested retry delay in ms
}

type NackReason =
  | 'queue_full'
  | 'rate_limited'
  | 'agent_busy'
  | 'priority_too_low'
  | 'guardrail_blocked'
  | 'invalid_target';
```

### Configuration

```typescript
interface BackpressureConfig {
  enabled: boolean;

  // Per-agent queue limits
  maxQueuePerAgent: number;   // Default: 1000

  // Priority lanes
  priorityLanes: {
    critical: { minPriority: 90, reservedCapacity: 0.2 };
    high: { minPriority: 70, reservedCapacity: 0.3 };
    normal: { minPriority: 0, reservedCapacity: 0.5 };
  };

  // Rate limiting
  rateLimit: {
    enabled: boolean;
    messagesPerSecond: number;  // Per agent
    burstSize: number;          // Token bucket burst
  };

  // Dead letter queue
  deadLetter: {
    enabled: boolean;
    maxSize: number;
    ttl: number;
  };

  // Retry policy
  retry: {
    maxAttempts: number;
    backoffMs: number;
    maxBackoffMs: number;
  };
}
```

### SDK API

```typescript
class RelayClient {
  // Send with priority
  sendMessage(to: string, body: string, kind?: PayloadKind, data?: unknown, options?: SendOptions): boolean;

  // Check if target can receive
  canSend(to: string): Promise<{ ready: boolean; queueDepth?: number; estimatedWait?: number }>;

  // Flow control events
  onBusy?: (agent: string, info: BusyInfo) => void;
  onReady?: (agent: string) => void;
  onNack?: (messageId: string, reason: NackReason, retryAfter?: number) => void;
}

interface SendOptions {
  priority?: number;          // 0-100 (higher = more urgent)
  ttl?: number;               // Time-to-live in ms
  retryPolicy?: RetryPolicy;
  deadLetterOnFail?: boolean;
}

interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}
```

### Architecture

```
                  Incoming Message
                         │
                         ▼
              ┌─────────────────────┐
              │    Rate Limiter     │
              │  (Token Bucket)     │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │   Priority Router   │
              │                     │
              │  ┌─────────────┐   │
              │  │  Critical   │◄──┼── Priority >= 90
              │  │   Queue     │   │
              │  └─────────────┘   │
              │  ┌─────────────┐   │
              │  │    High     │◄──┼── Priority >= 70
              │  │   Queue     │   │
              │  └─────────────┘   │
              │  ┌─────────────┐   │
              │  │   Normal    │◄──┼── Priority < 70
              │  │   Queue     │   │
              │  └─────────────┘   │
              └──────────┬──────────┘
                         │
                         ▼ (Queue full?)
              ┌─────────────────────┐
              │   Dead Letter       │
              │      Queue          │
              └─────────────────────┘
```

### Usage Examples

```typescript
// Send critical message that bypasses normal queue
client.sendMessage('Lead', 'CRITICAL: Security breach detected', 'action',
  { alert: true },
  { priority: 100, ttl: 60000 }
);

// Check before sending large batch
const status = await client.canSend('Worker');
if (!status.ready) {
  console.log(`Worker busy, queue depth: ${status.queueDepth}`);
  await sleep(status.estimatedWait);
}

// Handle backpressure
client.onNack = (messageId, reason, retryAfter) => {
  if (reason === 'queue_full' && retryAfter) {
    setTimeout(() => retryMessage(messageId), retryAfter);
  } else if (reason === 'rate_limited') {
    slowDownSending();
  }
};

// Configure priority for all messages from this agent
client.defaultSendOptions = {
  priority: 50,
  retryPolicy: { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 10000 }
};
```

---

## 6. Attachments

### Overview

Support for large files beyond the 1MiB frame limit, with chunked upload/download and deduplication.

### Protocol Messages

#### ATTACHMENT_UPLOAD

Upload an attachment (or chunk).

```typescript
interface AttachmentUploadPayload {
  id: string;                 // Attachment ID
  filename: string;
  mimeType: string;
  size: number;               // Total size in bytes
  checksum: string;           // SHA-256 of complete file

  // Chunking
  chunk?: {
    index: number;
    total: number;
    data: string;             // Base64 encoded chunk
    checksum: string;         // SHA-256 of this chunk
  };

  // For small files (< 1MB), can include inline
  data?: string;              // Base64 encoded complete file
}
```

#### ATTACHMENT_UPLOAD_COMPLETE

Confirm all chunks received.

```typescript
interface AttachmentUploadCompletePayload {
  id: string;
  success: boolean;
  error?: string;
  url?: string;               // URL to access attachment
}
```

#### ATTACHMENT_DOWNLOAD

Request attachment download.

```typescript
interface AttachmentDownloadPayload {
  id: string;
  range?: {
    start: number;
    end: number;
  };
}
```

#### ATTACHMENT_DATA

Attachment data (response).

```typescript
interface AttachmentDataPayload {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  data: string;               // Base64 encoded
  range?: {
    start: number;
    end: number;
    total: number;
  };
}
```

### SDK API

```typescript
class RelayClient {
  attachments: {
    // Upload
    upload(file: Buffer | Uint8Array | ReadableStream, options: UploadOptions): Promise<AttachmentRef>;
    uploadFile(path: string, options?: UploadOptions): Promise<AttachmentRef>;

    // Download
    download(ref: AttachmentRef): Promise<Buffer>;
    downloadToFile(ref: AttachmentRef, path: string): Promise<void>;
    downloadStream(ref: AttachmentRef): ReadableStream;

    // Metadata
    getInfo(ref: AttachmentRef): Promise<AttachmentInfo>;

    // Cleanup
    delete(ref: AttachmentRef): Promise<void>;

    // List attachments
    list(options?: ListOptions): Promise<AttachmentInfo[]>;
  };
}

interface UploadOptions {
  filename: string;
  mimeType?: string;          // Auto-detected if not provided
  ttl?: number;               // Time-to-live in ms
  tags?: string[];
}

interface AttachmentRef {
  id: string;
  checksum: string;
}

interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  checksum: string;
  createdAt: number;
  createdBy: string;
  expiresAt?: number;
  tags?: string[];
}
```

### Message Integration

```typescript
// Send message with attachment
const attachment = await client.attachments.upload(buffer, {
  filename: 'report.pdf',
  mimeType: 'application/pdf'
});

client.sendMessage('Analyst', 'Please review the attached report', 'action', {
  attachments: [attachment]
});

// Receive and download
client.onMessage = async (from, { body, data }) => {
  if (data?.attachments) {
    for (const ref of data.attachments) {
      const buffer = await client.attachments.download(ref);
      console.log(`Downloaded ${ref.id}: ${buffer.length} bytes`);
    }
  }
};
```

### Storage Configuration

```typescript
interface AttachmentConfig {
  enabled: boolean;

  // Storage backend
  storage: 'local' | 's3' | 'gcs';

  // Local storage
  local?: {
    path: string;             // Storage directory
    maxSize: number;          // Max total storage in bytes
  };

  // S3 storage
  s3?: {
    bucket: string;
    region: string;
    prefix?: string;
  };

  // Limits
  maxFileSize: number;        // Max single file size (default: 100MB)
  maxTotalSize: number;       // Max total storage per project
  defaultTtl: number;         // Default TTL in ms

  // Chunking
  chunkSize: number;          // Chunk size in bytes (default: 1MB)

  // Deduplication
  deduplication: boolean;     // Store identical files once
}
```

### Database Schema

```sql
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  tags TEXT,  -- JSON array
  reference_count INTEGER DEFAULT 1  -- For deduplication
);

CREATE INDEX idx_attachments_checksum ON attachments(checksum);
CREATE INDEX idx_attachments_expires ON attachments(expires_at);
```

---

## 7. Roles & Permissions

### Overview

Role-based access control for agents, defining what actions each agent can perform.

### Role Definitions

```typescript
interface RoleDefinition {
  name: string;
  permissions: Permission[];
  inherits?: string[];        // Inherit from other roles
}

type Permission =
  // Messaging
  | 'message:send'
  | 'message:broadcast'
  | 'message:send:any'        // Can send to any agent
  | 'message:send:team'       // Can only send to team members

  // Channels
  | 'channel:join'
  | 'channel:create'
  | 'channel:admin'

  // Spawning
  | 'spawn:create'
  | 'spawn:release'
  | 'spawn:release:own'       // Can only release agents you spawned

  // Consensus
  | 'consensus:propose'
  | 'consensus:vote'

  // Memory
  | 'memory:read'
  | 'memory:write'
  | 'memory:write:shared'
  | 'memory:delete'

  // HITL
  | 'approval:request'
  | 'approval:respond'
  | 'escalation:create'
  | 'intervention:perform'

  // Admin
  | 'admin:agents'            // View/manage agents
  | 'admin:config'            // Modify daemon config
  | 'admin:guardrails'        // Manage guardrails
  | '*';                      // All permissions
```

### Protocol Messages

#### ROLE_ASSIGN

Assign a role to an agent.

```typescript
interface RoleAssignPayload {
  agent: string;
  role: string;
  assignedBy: string;
  expiresAt?: number;
}
```

#### ROLE_REVOKE

Revoke a role from an agent.

```typescript
interface RoleRevokePayload {
  agent: string;
  role: string;
  revokedBy: string;
  reason?: string;
}
```

#### PERMISSION_CHECK

Check if an agent has a permission (internal).

```typescript
interface PermissionCheckPayload {
  agent: string;
  permission: Permission;
  context?: Record<string, unknown>;
}

interface PermissionCheckResponsePayload {
  allowed: boolean;
  reason?: string;
}
```

### SDK API

```typescript
class RelayClient {
  roles: {
    // Role management (requires admin:agents)
    assign(agent: string, role: string, options?: AssignOptions): Promise<void>;
    revoke(agent: string, role: string): Promise<void>;
    getRoles(agent: string): Promise<string[]>;

    // Permission checking
    can(permission: Permission): boolean;
    canAgent(agent: string, permission: Permission): Promise<boolean>;

    // Role definitions (requires admin:config)
    defineRole(definition: RoleDefinition): Promise<void>;
    listRoles(): Promise<RoleDefinition[]>;
  };
}

interface AssignOptions {
  expiresAt?: number;
  reason?: string;
}
```

### Built-in Roles

```typescript
const BUILT_IN_ROLES: Record<string, RoleDefinition> = {
  // Full access
  admin: {
    name: 'admin',
    permissions: ['*']
  },

  // Can coordinate but not admin
  lead: {
    name: 'lead',
    permissions: [
      'message:send:any',
      'message:broadcast',
      'channel:join',
      'channel:create',
      'spawn:create',
      'spawn:release:own',
      'consensus:propose',
      'consensus:vote',
      'memory:read',
      'memory:write',
      'approval:request',
      'approval:respond',
      'escalation:create'
    ]
  },

  // Standard worker
  worker: {
    name: 'worker',
    permissions: [
      'message:send:team',
      'channel:join',
      'consensus:vote',
      'memory:read',
      'memory:write',
      'escalation:create'
    ]
  },

  // Read-only observer
  observer: {
    name: 'observer',
    permissions: [
      'memory:read'
    ]
  },

  // Human user
  human: {
    name: 'human',
    permissions: [
      'message:send:any',
      'approval:respond',
      'intervention:perform',
      'admin:agents'
    ]
  }
};
```

### Configuration

```typescript
interface RolesConfig {
  enabled: boolean;

  // Default role for new agents
  defaultRole: string;        // Default: 'worker'

  // Role definitions
  roles: RoleDefinition[];

  // Team definitions (for 'send:team' permission)
  teams: TeamDefinition[];

  // Enforcement
  enforcement: 'strict' | 'warn' | 'disabled';
}

interface TeamDefinition {
  name: string;
  members: string[];          // Agent names or patterns
  lead?: string;
}
```

### Usage Examples

```typescript
// Assign role when spawning
await client.spawn({
  name: 'Worker1',
  cli: 'claude',
  task: '...',
  role: 'worker'
});

// Check permission before action
if (client.roles.can('spawn:create')) {
  await client.spawn({ ... });
} else {
  await client.hitl.escalate({
    type: 'permission',
    summary: 'Need spawn permission',
    escalateTo: ['Lead']
  });
}

// Assign elevated role temporarily
await client.roles.assign('Worker1', 'lead', {
  expiresAt: Date.now() + 3600000,  // 1 hour
  reason: 'Temporary lead role while Lead is offline'
});

// Define custom role
await client.roles.defineRole({
  name: 'security-reviewer',
  permissions: [
    'message:send:any',
    'memory:read',
    'admin:guardrails'
  ],
  inherits: ['worker']
});
```

---

## 8. Task Queues

### Overview

Persistent task queues with claiming, priorities, and progress tracking. Beyond channels for structured work distribution.

### Protocol Messages

#### TASK_PUSH

Add a task to a queue.

```typescript
interface TaskPushPayload {
  queue: string;              // Queue name (e.g., '#frontend-tasks')
  task: TaskDefinition;
}

interface TaskDefinition {
  id: string;
  title: string;
  description?: string;
  priority: number;           // 0-100
  data?: unknown;             // Task-specific data
  dependencies?: string[];    // Task IDs that must complete first
  timeout?: number;           // Max processing time in ms
  retryPolicy?: RetryPolicy;
  assignTo?: string[];        // Preferred assignees
  tags?: string[];
}
```

#### TASK_CLAIM

Claim a task from a queue.

```typescript
interface TaskClaimPayload {
  queue: string;
  taskId?: string;            // Specific task or next available
  filter?: {
    tags?: string[];
    maxPriority?: number;
    minPriority?: number;
  };
}

interface TaskClaimResponsePayload {
  success: boolean;
  task?: TaskInfo;
  reason?: string;            // If failed
}

interface TaskInfo extends TaskDefinition {
  status: TaskStatus;
  claimedBy?: string;
  claimedAt?: number;
  attempts: number;
  progress?: number;          // 0-100
  lastUpdate?: number;
}

type TaskStatus = 'pending' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'blocked';
```

#### TASK_UPDATE

Update task progress.

```typescript
interface TaskUpdatePayload {
  queue: string;
  taskId: string;
  progress?: number;          // 0-100
  status?: TaskStatus;
  message?: string;
}
```

#### TASK_COMPLETE

Mark task as completed.

```typescript
interface TaskCompletePayload {
  queue: string;
  taskId: string;
  result?: unknown;
  metrics?: {
    duration: number;
    tokensUsed?: number;
  };
}
```

#### TASK_FAIL

Mark task as failed.

```typescript
interface TaskFailPayload {
  queue: string;
  taskId: string;
  error: string;
  retry?: boolean;            // Should daemon retry?
}
```

#### TASK_RELEASE

Release a claimed task back to the queue.

```typescript
interface TaskReleasePayload {
  queue: string;
  taskId: string;
  reason?: string;
}
```

### SDK API

```typescript
class RelayClient {
  tasks: {
    // Queue management
    createQueue(name: string, options?: QueueOptions): Promise<void>;
    deleteQueue(name: string): Promise<void>;
    listQueues(): Promise<QueueInfo[]>;

    // Task operations
    push(queue: string, task: TaskInput): Promise<string>;  // Returns task ID
    pushBatch(queue: string, tasks: TaskInput[]): Promise<string[]>;

    claim(queue: string, options?: ClaimOptions): Promise<Task | null>;
    release(queue: string, taskId: string, reason?: string): Promise<void>;

    update(queue: string, taskId: string, update: TaskUpdate): Promise<void>;
    complete(queue: string, taskId: string, result?: unknown): Promise<void>;
    fail(queue: string, taskId: string, error: string, retry?: boolean): Promise<void>;

    // Query
    get(queue: string, taskId: string): Promise<Task | null>;
    list(queue: string, options?: ListOptions): Promise<Task[]>;
    stats(queue: string): Promise<QueueStats>;

    // Watch for tasks (worker pattern)
    watch(queue: string, handler: TaskHandler, options?: WatchOptions): TaskWatcher;
  };
}

interface QueueOptions {
  maxSize?: number;
  defaultPriority?: number;
  defaultTimeout?: number;
  retryPolicy?: RetryPolicy;
  visibility?: 'public' | 'team' | 'private';
}

interface QueueInfo {
  name: string;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  createdAt: number;
}

interface QueueStats {
  pending: number;
  inProgress: number;
  completed24h: number;
  failed24h: number;
  avgProcessingTime: number;
  throughput: number;         // Tasks per minute
}

interface TaskInput {
  title: string;
  description?: string;
  priority?: number;
  data?: unknown;
  dependencies?: string[];
  timeout?: number;
  tags?: string[];
}

interface ClaimOptions {
  taskId?: string;
  filter?: {
    tags?: string[];
    maxPriority?: number;
    minPriority?: number;
  };
  timeout?: number;           // Wait for task if queue empty
}

type TaskHandler = (task: Task) => Promise<unknown>;

interface TaskWatcher {
  stop(): void;
  pause(): void;
  resume(): void;
}

interface WatchOptions {
  concurrency?: number;       // Max concurrent tasks
  pollInterval?: number;      // Polling interval in ms
  filter?: ClaimOptions['filter'];
}
```

### Database Schema

```sql
CREATE TABLE task_queues (
  name TEXT PRIMARY KEY,
  options TEXT,  -- JSON
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL REFERENCES task_queues(name),
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  data TEXT,  -- JSON
  dependencies TEXT,  -- JSON array of task IDs
  timeout INTEGER,
  tags TEXT,  -- JSON array
  status TEXT NOT NULL DEFAULT 'pending',
  claimed_by TEXT,
  claimed_at INTEGER,
  attempts INTEGER DEFAULT 0,
  progress INTEGER DEFAULT 0,
  result TEXT,  -- JSON
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX idx_tasks_queue_status ON tasks(queue, status);
CREATE INDEX idx_tasks_priority ON tasks(priority DESC);
CREATE INDEX idx_tasks_claimed_by ON tasks(claimed_by);
CREATE INDEX idx_tasks_dependencies ON tasks(dependencies);
```

### Usage Examples

```typescript
// Create a task queue
await client.tasks.createQueue('#frontend-tasks', {
  defaultPriority: 50,
  defaultTimeout: 3600000,  // 1 hour
  retryPolicy: { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 30000 }
});

// Push tasks with dependencies
const task1 = await client.tasks.push('#frontend-tasks', {
  title: 'Design login page',
  priority: 80,
  tags: ['design', 'auth']
});

const task2 = await client.tasks.push('#frontend-tasks', {
  title: 'Implement login form',
  dependencies: [task1],
  tags: ['implementation', 'auth']
});

// Worker claiming and processing
const watcher = client.tasks.watch('#frontend-tasks', async (task) => {
  console.log(`Processing: ${task.title}`);

  // Update progress
  await client.tasks.update('#frontend-tasks', task.id, { progress: 50 });

  // Do work...
  const result = await processTask(task);

  return result;  // Auto-completes the task
}, {
  concurrency: 2,
  filter: { tags: ['implementation'] }
});

// Manual claim for specific work
const task = await client.tasks.claim('#frontend-tasks', {
  filter: { tags: ['urgent'] },
  timeout: 5000  // Wait up to 5s for a task
});

if (task) {
  try {
    await processTask(task);
    await client.tasks.complete('#frontend-tasks', task.id, { success: true });
  } catch (error) {
    await client.tasks.fail('#frontend-tasks', task.id, error.message, true);
  }
}

// Check queue stats
const stats = await client.tasks.stats('#frontend-tasks');
console.log(`Pending: ${stats.pending}, Throughput: ${stats.throughput}/min`);
```

---

## Implementation Roadmap

### Phase 1: Foundation (P0)

1. **Memory System** - Core primitive that everything else needs
2. **Guardrails** - Essential for production safety

### Phase 2: Visibility (P1)

3. **Tracing & Observability** - Debug and monitor
4. **Human-in-the-Loop** - Enterprise requirement

### Phase 3: Scale (P2)

5. **Backpressure & Flow Control** - Handle load
6. **Attachments** - Large file support

### Phase 4: Structure (P3)

7. **Roles & Permissions** - Security and governance
8. **Task Queues** - Structured work distribution

### Migration Notes

All new primitives should:

1. Be **opt-in** via configuration
2. Have **feature flags** for gradual rollout
3. Include **migration paths** from current patterns
4. Maintain **backward compatibility** with existing SDK

### Protocol Versioning

New message types will be added under protocol version 2:

```typescript
const PROTOCOL_VERSION = 2;

// New message types
type MessageType =
  // ... existing types
  | 'MEMORY_SET' | 'MEMORY_GET' | 'MEMORY_SEARCH' | 'MEMORY_DELETE' | 'MEMORY_LIST'
  | 'GUARDRAIL_REGISTER' | 'GUARDRAIL_RESULT'
  | 'TRACE_START' | 'TRACE_EVENT' | 'TRACE_END' | 'TRACE_QUERY'
  | 'APPROVAL_REQUEST' | 'APPROVAL_RESPONSE' | 'ESCALATION' | 'INTERVENTION'
  | 'BUSY' | 'READY'
  | 'ATTACHMENT_UPLOAD' | 'ATTACHMENT_DOWNLOAD' | 'ATTACHMENT_DATA'
  | 'ROLE_ASSIGN' | 'ROLE_REVOKE' | 'PERMISSION_CHECK'
  | 'TASK_PUSH' | 'TASK_CLAIM' | 'TASK_UPDATE' | 'TASK_COMPLETE' | 'TASK_FAIL' | 'TASK_RELEASE';
```

---

## Competitive Differentiation

With these primitives, Agent Relay will uniquely offer:

| Capability | Agent Relay | OpenAI Agents | LangGraph | CrewAI |
|------------|-------------|---------------|-----------|--------|
| Sub-5ms latency | **Yes** | No | No | No |
| Native consensus | **Yes** | No | No | No |
| Shadow monitoring | **Yes** | No | No | No |
| Sync messaging | **Yes** | No | No | No |
| CLI-agnostic | **Yes** | No | No | No |
| Memory system | **Yes** (new) | Sessions | Yes | Yes |
| Guardrails | **Yes** (new) | Yes | Via LangChain | No |
| Tracing/OTEL | **Yes** (new) | Yes | Via LangSmith | No |
| HITL | **Yes** (new) | Yes | No | No |
| Task queues | **Yes** (new) | No | No | No |

**Agent Relay: The only framework with all primitives for production multi-agent systems.**
