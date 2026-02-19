# Ad-hoc Swarm Invocation

**Status:** Proposal
**Author:** Lead
**Created:** 2026-02-19

## Summary

Enable agents to dynamically invoke swarm patterns during conversations, rather than only running workflows via predetermined CLI commands or SDK calls.

## Motivation

Currently, agent-relay workflows are deterministic and require upfront orchestration:

```bash
# Current: Top-down, predetermined
agent-relay run --template competitive --task "Design caching layer"
```

This works well for known workflows, but agents often encounter situations mid-conversation where they would benefit from diverse perspectives, parallel exploration, or structured coordination patterns.

**Example scenario:** An agent working on a complex architecture decision realizes it would benefit from multiple independent approaches. Currently, it cannot spawn a competitive swarm—it must complete its work linearly or the human must manually orchestrate a new workflow.

## Proposal

### CLI Approach

Expose swarm patterns as first-class CLI commands that agents can invoke:

```bash
# Spawn a swarm with a specific pattern
agent-relay swarm --pattern competitive --task "Design caching strategy for user API"

# With customization
agent-relay swarm --pattern competitive \
  --teams 2 \
  --timeout 30m \
  --task "Evaluate Redis vs Memcached for session storage"

# List available patterns
agent-relay swarm --list
```

### Relay Protocol Approach

Extend the relay protocol to support swarm spawning via message:

```
KIND: swarm
PATTERN: competitive
TIMEOUT: 30m

Design caching strategy for user API.
Compare Redis, Memcached, and in-memory approaches.
```

The broker would:
1. Parse the swarm request
2. Load the pattern template
3. Spawn the required agents
4. Coordinate execution
5. Return synthesized results to the requesting agent

### Response Flow

Results flow back to the requesting agent:

```
Relay message from swarm:competitive [abc123]:

SWARM_COMPLETE

Winner: Team Alpha (Redis approach)
Rationale: Best balance of performance and operational simplicity.

Team Alpha: Redis with TTL-based eviction...
Team Beta: Memcached cluster with consistent hashing...
Team Gamma: In-memory LRU with write-through...
```

## Open Questions

### 1. Synchronous vs Asynchronous Execution

**Option A: Synchronous (blocking)**
- Agent waits for swarm completion
- Simpler mental model
- Risk: Long-running swarms block the conversation

**Option B: Asynchronous (callback)**
- Agent continues working, receives notification on completion
- More complex state management
- Better for long-running swarms

**Option C: Hybrid**
- Short swarms (< 5 min) are synchronous
- Long swarms spawn async with callback
- Configurable threshold

### 2. Context Flow

How does the swarm receive context from the spawning conversation?

**Option A: Explicit task only**
- Swarm only receives the task string
- Clean isolation
- May miss important context

**Option B: Context injection**
- Include recent conversation history
- Richer context for swarm agents
- Privacy/scope concerns

**Option C: Selective context**
- Agent explicitly specifies what context to include
- `CONTEXT: last 5 messages` or `CONTEXT: file:src/cache.ts`

### 3. Pattern Customization

Should agents customize patterns on-the-fly?

```
KIND: swarm
PATTERN: competitive
TEAMS: 2
AGENTS: claude, codex

Task here.
```

**Considerations:**
- Flexibility vs complexity
- Validation of custom configurations
- Fallback to defaults for missing fields

### 4. Result Integration

How do swarm results integrate back into the conversation?

**Option A: Summary only**
- Return winning solution + brief rationale
- Compact, actionable

**Option B: Full transcript**
- Return all team outputs
- Complete but verbose

**Option C: Structured output**
- JSON/structured format for programmatic use
- `{ winner: "alpha", solutions: [...], comparison: {...} }`

### 5. Resource Limits

How to prevent runaway swarm spawning?

- Max concurrent swarms per agent?
- Max swarm depth (swarm spawning swarm)?
- Token/cost budgets?
- Approval workflow for expensive patterns?

### 6. Error Handling

What happens when a swarm fails mid-execution?

- Partial results returned?
- Automatic retry?
- Notification to spawning agent?
- Rollback semantics?

## Implementation Phases

### Phase 1: CLI Foundation
- Add `agent-relay swarm` command
- Support `--pattern` and `--task` flags
- Synchronous execution only
- Return results to stdout

### Phase 2: Protocol Integration
- Add `KIND: swarm` to relay protocol
- Broker-side swarm orchestration
- Result delivery via relay messages

### Phase 3: Async & Customization
- Async execution with callbacks
- Pattern customization options
- Context injection controls

### Phase 4: Governance
- Resource limits and quotas
- Approval workflows
- Audit logging

## Alternatives Considered

### 1. MCP Tool Approach

Expose swarm invocation as an MCP tool rather than relay protocol extension.

**Pros:** Standard tool interface, works with any MCP client
**Cons:** Less integrated with relay messaging, separate auth flow

### 2. Workflow Composition

Allow workflows to reference other workflows as steps.

**Pros:** Reuses existing workflow infrastructure
**Cons:** Still requires upfront definition, not truly ad-hoc

### 3. Agent Spawning Only

Let agents spawn individual agents and coordinate manually.

**Pros:** Maximum flexibility
**Cons:** Loses pattern benefits, each agent reinvents coordination

## Success Criteria

1. An agent can spawn a competitive swarm in < 3 commands
2. Swarm results integrate naturally into conversation flow
3. No manual human intervention required for basic swarm patterns
4. Clear error messages when swarms fail or timeout
5. Resource usage is bounded and predictable
