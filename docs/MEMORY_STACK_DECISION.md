# Memory Stack Decision: Mem0 as Foundation

**Date:** 2025-12-21
**Status:** Proposed

## Decision

Use [Mem0](https://github.com/mem0ai/mem0) as the memory substrate for agent-trajectories rather than building from scratch.

## Context

We evaluated cross-platform memory solutions before building our own:

| Solution | Stars | Focus | Multi-Agent | MCP Support |
|----------|-------|-------|-------------|-------------|
| [Mem0](https://github.com/mem0ai/mem0) | 25k+ | Universal memory API | ✅ | ✅ |
| [Zep](https://github.com/getzep/zep) | 3k+ | Temporal knowledge graph | ✅ | ❓ |
| [Letta](https://github.com/letta-ai/letta) | 20k+ | Stateful agents | ✅ | ❓ |
| [Cognee](https://github.com/topoteretes/cognee) | 4k+ | Document → graph | ⚠️ | ✅ |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Popular | Claude Code memory | ❌ Single agent | ❌ Claude only |

## Why Mem0

1. **Most popular** - 25k+ stars, active development, YC-backed
2. **Multi-LLM support** - Not locked to OpenAI (works with Anthropic, etc.)
3. **MCP integration exists** - Works with Claude Code today via [Composio MCP](https://mcp.composio.dev/mem0)
4. **Self-hosted option** - Apache 2.0 license
5. **Python + TypeScript SDKs** - Matches our stack
6. **Performance claims** - +26% accuracy vs OpenAI Memory, 91% faster, 90% fewer tokens

## Why Not Others

| Solution | Why Not Primary |
|----------|-----------------|
| **Zep** | More complex (Graphiti), cloud-first pivot |
| **Letta** | Full agent framework, not just memory |
| **Cognee** | Document-focused, less mature |
| **claude-mem** | Claude Code only, not multi-agent |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AGENT MEMORY STACK                                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              agent-trajectories (our layer)                          │   │
│  │                                                                      │   │
│  │  BUILDS ON MEM0:                        ADDS:                       │   │
│  │  • Uses Mem0 for observation storage    • Task-based grouping       │   │
│  │  • Uses Mem0 for semantic search        • Inter-agent events        │   │
│  │  • Uses Mem0's multi-user isolation     • Fleet knowledge workspace │   │
│  │                                         • .trajectory export        │   │
│  │                                         • Decisions & patterns      │   │
│  └──────────────────────────────────┬──────────────────────────────────┘   │
│                                     │ uses                                  │
│                                     ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Mem0 (memory substrate)                      │   │
│  │                                                                      │   │
│  │  • Observation storage + retrieval                                  │   │
│  │  • Semantic search (vector + hybrid)                                │   │
│  │  • Multi-user/agent isolation                                       │   │
│  │  • MCP integration for Claude Code                                  │   │
│  │  • Self-hosted or cloud                                             │   │
│  └──────────────────────────────────┬──────────────────────────────────┘   │
│                                     │                                       │
│          ┌──────────────────────────┼──────────────────────────┐           │
│          ▼                          ▼                          ▼           │
│  ┌──────────────┐          ┌──────────────┐          ┌──────────────┐     │
│  │ Claude agent │          │ Codex agent  │          │ Gemini agent │     │
│  │ (MCP→Mem0)   │          │ (SDK→Mem0)   │          │ (SDK→Mem0)   │     │
│  └──────────────┘          └──────────────┘          └──────────────┘     │
│                                                                              │
│  ◄──────────────────── agent-relay provides messaging ──────────────────►  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## What We Build vs Use

| Component | Build or Use | Owner |
|-----------|--------------|-------|
| Observation storage | **USE Mem0** | Mem0 |
| Semantic search | **USE Mem0** | Mem0 |
| Vector database | **USE Mem0** | Mem0 |
| Task-based grouping | **BUILD** | agent-trajectories |
| Trajectory format (.trajectory) | **BUILD** | agent-trajectories |
| Knowledge workspace | **BUILD** | agent-trajectories |
| Inter-agent event capture | **BUILD** | agent-trajectories |
| Fleet-wide patterns/decisions | **BUILD** | agent-trajectories |
| Message routing | **USE** | agent-relay |

## Integration Points

### 1. Mem0 as Storage Backend

```typescript
// agent-trajectories uses Mem0 for observation storage
import { Memory } from 'mem0ai';

const memory = new Memory({
  // Self-hosted or cloud
  api_key: process.env.MEM0_API_KEY,
});

// Store trajectory events as Mem0 memories
async function storeTrajectoryEvent(event: TrajectoryEvent) {
  await memory.add({
    messages: [{ role: 'assistant', content: event.content }],
    user_id: event.agentId,
    metadata: {
      trajectory_id: event.trajectoryId,
      task_id: event.taskId,
      event_type: event.type,
      ts: event.ts,
    },
  });
}

// Retrieve relevant context for an agent
async function getAgentContext(agentId: string, query: string) {
  return memory.search({
    query,
    user_id: agentId,
    limit: 10,
  });
}
```

### 2. MCP for Claude Code Agents

```json
// Claude Code MCP config (~/.claude/mcp.json)
{
  "mcpServers": {
    "mem0": {
      "command": "npx",
      "args": ["-y", "@mem0/mcp-server"],
      "env": {
        "MEM0_API_KEY": "${MEM0_API_KEY}"
      }
    }
  }
}
```

### 3. agent-relay Event Emission

```typescript
// agent-relay emits events
relay.on('message', (msg) => {
  // Forward to agent-trajectories
  trajectories.captureEvent({
    type: 'inter_agent_message',
    from: msg.from,
    to: msg.to,
    content: msg.content,
    ts: msg.ts,
  });
});
```

## Alternatives Considered

### Option A: Build Everything (Rejected)
- SQLite + FTS5 + Chroma from scratch
- **Rejected:** 3-4 weeks of work Mem0 already does

### Option B: Fork claude-mem (Rejected)
- Extend claude-mem for multi-agent
- **Rejected:** Too Claude-specific, massive refactor needed

### Option C: Use Zep (Considered)
- Temporal knowledge graph is powerful
- **Deferred:** More complex, can add later if needed

### Option D: Use Mem0 + Build On Top (Selected)
- Best of both worlds
- Use mature memory infra, add our task/trajectory layer

## Migration Path

If Mem0 doesn't meet needs, the abstraction allows swapping:

```typescript
interface MemoryBackend {
  add(memory: Memory): Promise<void>;
  search(query: string, options: SearchOptions): Promise<Memory[]>;
  delete(id: string): Promise<void>;
}

// Default: Mem0
class Mem0Backend implements MemoryBackend { ... }

// Alternative: Zep (if we need temporal graphs)
class ZepBackend implements MemoryBackend { ... }

// Fallback: Custom SQLite + Chroma
class LocalBackend implements MemoryBackend { ... }
```

## Next Steps

1. Add Mem0 dependency to agent-trajectories
2. Implement MemoryBackend interface with Mem0
3. Add MCP configuration for Claude Code agents
4. Build task-based trajectory layer on top
5. Integrate with agent-relay event emission

## References

- [Mem0 GitHub](https://github.com/mem0ai/mem0)
- [Mem0 Documentation](https://docs.mem0.ai/)
- [Mem0 MCP Integration](https://mcp.composio.dev/mem0)
- [Collaborative Memory Paper](https://arxiv.org/html/2505.18279v1)
- [MemEngine Paper](https://arxiv.org/html/2505.02099v1)
