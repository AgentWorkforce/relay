# Multi-Agent Coordination: Architecture Decisions

This document compares approaches to multi-agent coordination and explains when to use each.

## Two Approaches

### 1. Subagents (Hierarchical)

Spawn child agents from a parent, collect results, continue.

```
       ┌─────────┐
       │ Parent  │
       └────┬────┘
            │ spawn
    ┌───────┼───────┐
    ▼       ▼       ▼
┌───────┐┌───────┐┌───────┐
│ Child ││ Child ││ Child │
└───────┘└───────┘└───────┘
    │       │       │
    └───────┼───────┘
            ▼ return
       ┌─────────┐
       │ Parent  │
       └─────────┘
```

**Characteristics:**
- Tree topology (parent orchestrates)
- Synchronous - parent waits for children
- Ephemeral - children die after returning
- State held by parent
- No peer-to-peer communication

### 2. Agent-Relay (Mesh)

Persistent agents communicate via message passing.

```
┌───────┐     ┌───────┐
│ Agent │◄───►│ Agent │
└───┬───┘     └───┬───┘
    │             │
    └──────┬──────┘
           ▼
    ┌─────────────┐
    │   Daemon    │ ← routes messages
    │  (router)   │ ← persists history
    └─────────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌───────┐     ┌───────┐
│ Agent │◄───►│ Agent │
└───────┘     └───────┘
```

**Characteristics:**
- Mesh topology (any-to-any)
- Asynchronous - fire and respond
- Persistent - agents live across tasks
- Distributed state + message log
- Direct peer communication

## Decision Matrix

| Requirement | Subagents | Agent-Relay |
|-------------|:---------:|:-----------:|
| Simple one-shot tasks | ✅ | ⚠️ overkill |
| Clear parent/child hierarchy | ✅ | ✅ |
| No infrastructure to manage | ✅ | ❌ |
| Agents debate/negotiate | ❌ | ✅ |
| Long-running agents | ❌ | ✅ |
| Mix different AI providers | ⚠️ limited | ✅ |
| Audit trail / replay | ❌ | ✅ |
| External observability | ❌ | ✅ |
| Horizontal scaling | ❌ | ✅ |
| Resume after crash | ❌ | ✅ |

## When to Use Subagents

Choose subagents when:

1. **Tasks are independent** - Fan out, collect, aggregate
2. **Hierarchy is natural** - One coordinator, many workers
3. **No persistence needed** - Results matter, not the conversation
4. **Same provider** - All agents are Claude (or same SDK)
5. **Simplicity wins** - Fewer moving parts

**Example use cases:**
- Parallel code analysis (security, perf, style)
- Research tasks with multiple queries
- Map-reduce style workloads
- One-time batch processing

```typescript
// Subagent pattern
const [security, perf, style] = await Promise.all([
  analyzeSecurityAgent(code),
  analyzePerfAgent(code),
  analyzeStyleAgent(code),
]);
return summarize(security, perf, style);
```

## When to Use Agent-Relay

Choose agent-relay when:

1. **Agents need to discuss** - Back-and-forth negotiation
2. **Persistence matters** - Audit, debug, replay conversations
3. **Mixed ecosystem** - Claude + Codex + Gemini + custom bots
4. **External integration** - Dashboard, Slack, webhooks
5. **Long-running sessions** - Agents stay alive, handle multiple tasks
6. **Decoupling** - Add/remove agents without code changes

**Example use cases:**
- Collaborative document editing
- Multi-agent game playing
- Continuous monitoring systems
- Team simulations with distinct personas
- Human-in-the-loop workflows

```typescript
// Agent-relay pattern
const daemon = new Daemon({ socketPath, storagePath });
await daemon.start();

// Agents live independently, communicate async
const architect = new RelayClient({ name: 'Architect', socketPath });
const developer = new RelayClient({ name: 'Developer', socketPath });
const reviewer = new RelayClient({ name: 'Reviewer', socketPath });

// They message each other directly
architect.send({ to: 'Developer', body: 'Implement auth module' });
// Developer works, then...
developer.send({ to: 'Reviewer', body: 'Ready for review' });
// Reviewer responds to Developer directly
```

## Hybrid Approach

You can combine both:

```
┌─────────────────────────────────────┐
│           Orchestrator              │
│         (agent-relay)               │
└──────┬──────────────┬───────────────┘
       │              │
       ▼              ▼
┌─────────────┐ ┌─────────────┐
│  Team Lead  │ │  Team Lead  │
│  (relay)    │ │  (relay)    │
└──────┬──────┘ └──────┬──────┘
       │               │
   ┌───┴───┐       ┌───┴───┐
   ▼       ▼       ▼       ▼
┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
│Sub 1│ │Sub 2│ │Sub 3│ │Sub 4│  ← subagents
└─────┘ └─────┘ └─────┘ └─────┘
```

- **Agent-relay** for cross-team coordination
- **Subagents** for parallelizable work within a team

## Summary

| Approach | Mental Model | Best For |
|----------|--------------|----------|
| Subagents | Function calls | Hierarchical, stateless, one-shot |
| Agent-Relay | Microservices | Mesh, persistent, observable |

**Rule of thumb:** Start with subagents. Move to agent-relay when you need persistence, observability, or peer-to-peer communication.
