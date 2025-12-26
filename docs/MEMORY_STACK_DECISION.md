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

## Constraint: Claude Code Auth Only (No Direct SDK)

**Problem:** We use Claude Code via auth, not direct Anthropic SDK access. Mem0's TypeScript SDK requires LLM API access for memory extraction/compression.

**Solution:** Use MCP approach where **Claude Code IS the intelligence layer**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MCP-BASED MEMORY (Recommended)                           │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Claude Code Agent                               │   │
│  │                                                                      │   │
│  │  1. Agent decides what to remember (intelligence here)              │   │
│  │  2. Agent calls MCP tool: add_memory("user prefers dark mode")      │   │
│  │  3. Later: Agent calls search_memories("user preferences")          │   │
│  │  4. Agent uses retrieved memories in context                        │   │
│  └────────────────────────────────────┬────────────────────────────────┘   │
│                                       │ MCP calls                           │
│                                       ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Mem0 MCP Server                                 │   │
│  │                                                                      │   │
│  │  • add_memory(content, metadata)   → Store to vector DB             │   │
│  │  • search_memories(query)          → Vector search (no LLM needed)  │   │
│  │  • delete_memory(id)               → Remove from storage            │   │
│  │                                                                      │   │
│  │  NO LLM CALLS - Pure storage + retrieval                            │   │
│  └────────────────────────────────────┬────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│                             ┌──────────────────┐                           │
│                             │   Qdrant / Redis  │                           │
│                             │   (Vector Store)  │                           │
│                             └──────────────────┘                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why This Works

| Approach | LLM Needed? | Works with Claude Code Auth? |
|----------|-------------|------------------------------|
| Mem0 TypeScript SDK (full) | ✅ Yes, for extraction | ❌ No - requires API key |
| Mem0 MCP Server | ❌ No, agent is the LLM | ✅ Yes |
| Mem0 with `infer: false` | ❌ No, raw storage | ✅ Yes |

**Key Insight:** With MCP, the agent (Claude Code) does the "thinking" about what to remember. Mem0 becomes a dumb storage layer with smart retrieval (vector search).

### Integration Modes

| Mode | Use Case | LLM Required |
|------|----------|--------------|
| **MCP (Primary)** | Claude Code agents | No - agent is the LLM |
| **SDK with infer:false** | Programmatic storage | No - raw storage |
| **SDK with LLM** | Non-Claude agents with API keys | Yes - for extraction |

### MCP Server Options

1. **Mem0 Official MCP** - `@mem0/mcp-server`
2. **Composio MCP** - Third-party wrapper
3. **Custom MCP** - Build thin layer over Qdrant

### Embeddings Without API Keys

Vector search needs embeddings. Options without paid API:

| Option | Pros | Cons |
|--------|------|------|
| **Ollama** (local) | Free, private, fast | Requires local GPU/CPU |
| **HuggingFace TEI** | Free, self-hosted | Setup complexity |
| **Qdrant FastEmbed** | Built-in, no setup | Limited models |
| **OpenAI API** | Best quality | Requires API key + cost |

Recommended: **Ollama + nomic-embed-text** for local development, option to swap to OpenAI embeddings in production if quality matters.

## Integration Points

### 1. Mem0 as Storage Backend (No LLM Required)

```typescript
// agent-trajectories uses Mem0 for observation storage
// NOTE: Using infer:false - no LLM API needed
import { Memory } from 'mem0ai/oss';

const memory = new Memory({
  // Vector store only - no LLM config needed
  vectorStore: {
    provider: 'qdrant',
    config: {
      url: process.env.QDRANT_URL || 'http://localhost:6333',
      collectionName: 'trajectories',
    },
  },
  // Optional: embeddings can use local model or API
  embedder: {
    provider: 'ollama',  // Local embeddings, no API key
    config: { model: 'nomic-embed-text' },
  },
});

// Store trajectory events - raw storage, no extraction
async function storeTrajectoryEvent(event: TrajectoryEvent) {
  await memory.add(
    [{ role: 'assistant', content: event.content }],
    {
      user_id: event.agentId,
      metadata: {
        trajectory_id: event.trajectoryId,
        task_id: event.taskId,
        event_type: event.type,
        ts: event.ts,
      },
      infer: false,  // Skip LLM extraction - store as-is
    }
  );
}

// Retrieve relevant context - vector search only
async function getAgentContext(agentId: string, query: string) {
  return memory.search(query, {
    user_id: agentId,
    limit: 10,
  });
}
```

### 1b. Alternative: Direct Qdrant (Simpler)

If Mem0 adds complexity, use Qdrant directly:

```typescript
import { QdrantClient } from '@qdrant/js-client-rest';

const qdrant = new QdrantClient({ url: 'http://localhost:6333' });

// Store with pre-computed embeddings (from local model)
async function storeEvent(event: TrajectoryEvent, embedding: number[]) {
  await qdrant.upsert('trajectories', {
    points: [{
      id: event.id,
      vector: embedding,
      payload: {
        agentId: event.agentId,
        content: event.content,
        trajectoryId: event.trajectoryId,
        ts: event.ts,
      },
    }],
  });
}

// Search by vector similarity
async function search(queryEmbedding: number[], agentId: string) {
  return qdrant.search('trajectories', {
    vector: queryEmbedding,
    filter: { must: [{ key: 'agentId', match: { value: agentId } }] },
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

1. **Set up Qdrant** - Local vector store (docker or binary)
2. **Set up Ollama** - Local embeddings (nomic-embed-text)
3. **Configure Mem0 MCP** - For Claude Code agents
4. **Implement MemoryBackend** - With `infer: false` for programmatic use
5. **Build trajectory layer** - Task grouping, patterns on top
6. **Integrate with agent-relay** - Event emission to trajectories

## References

- [Mem0 GitHub](https://github.com/mem0ai/mem0)
- [Mem0 Documentation](https://docs.mem0.ai/)
- [Mem0 MCP Integration](https://mcp.composio.dev/mem0)
- [Collaborative Memory Paper](https://arxiv.org/html/2505.18279v1)
- [MemEngine Paper](https://arxiv.org/html/2505.02099v1)
