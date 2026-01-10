# Algolia Agent Memory: Implementation Specification

> **Competition**: Algolia Agent Studio Challenge
> **Category**: Non-Conversational Consumer-Facing Experience
> **Deadline**: February 8, 2026
> **Prize**: $750 per winner

---

## Executive Summary

**Agent Memory** is a searchable knowledge base of agent work history, powered by Algolia. It enables developers and teams to instantly search across all agent conversations, decisions, tasks, and code changes—surfacing relevant context without requiring a conversation.

**Differentiator**: No one else has this corpus. We're indexing the *reasoning* behind code, not just the code itself.

---

## Product Vision

### The Problem

When agents work on codebases, valuable context is lost:
- Why was this approach chosen over alternatives?
- Who worked on similar problems before?
- What decisions were made during implementation?
- What conversations led to this code?

### The Solution

A non-conversational search interface that proactively surfaces relevant agent work history:

```
┌─────────────────────────────────────────────────────────────────────┐
│  🔍 Search Agent History                           [Algolia-powered]│
├─────────────────────────────────────────────────────────────────────┤
│  "authentication implementation"                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  📋 Task: Add OAuth login with GitHub                               │
│  Agent: Alice • Completed 3 days ago • Priority: High               │
│  "Implemented OAuth flow with refresh tokens..."                     │
│                                                                      │
│  💭 Decision: JWT over sessions                                      │
│  Confidence: 85% • Agent: Alice                                      │
│  "Chose JWT for stateless scaling requirements"                      │
│                                                                      │
│  💬 Conversation Thread                                              │
│  Alice → Bob: "Let's use refresh tokens for security"               │
│  Bob → Alice: "ACK, updating middleware now"                         │
│                                                                      │
│  📝 Commit: e02d849                                                  │
│  "Add JWT auth with refresh token support"                          │
│  Files: src/auth/jwt.ts, src/middleware/auth.ts                     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Technical Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA SOURCES                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Messages   │  │    Beads     │  │    Trails    │              │
│  │  (relay)     │  │   (tasks)    │  │ (decisions)  │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                 │                        │
│         └────────────┬────┴────────────────┘                        │
│                      ▼                                               │
│         ┌────────────────────────┐                                  │
│         │   PostgreSQL Cloud     │                                  │
│         │   (agent_messages)     │                                  │
│         └────────────┬───────────┘                                  │
│                      │                                               │
└──────────────────────┼──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     ALGOLIA INDEXER                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │  Indexer Service (cron job / webhook triggered)            │     │
│  │                                                             │     │
│  │  1. Query agent_messages WHERE indexed_at IS NULL          │     │
│  │  2. Query beads via .beads/issues.jsonl                    │     │
│  │  3. Query trails via .trajectories/                        │     │
│  │  4. Transform to unified AgentWorkRecord schema            │     │
│  │  5. Batch push to Algolia                                  │     │
│  │  6. Mark records as indexed                                │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     ALGOLIA INDEX                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Index: agent-work-history                                          │
│                                                                      │
│  Searchable Attributes:                                             │
│  - title (task title, commit message, decision summary)             │
│  - content (full text body)                                         │
│  - agent (who created this)                                         │
│  - files[] (related file paths)                                     │
│                                                                      │
│  Facets:                                                            │
│  - type (message, bead, trail, commit)                              │
│  - status (open, closed, completed)                                 │
│  - agent                                                            │
│  - confidence (for decisions)                                       │
│                                                                      │
│  Custom Ranking:                                                    │
│  - timestamp (desc) - recent first                                  │
│  - confidence (desc) - high confidence first                        │
│  - priority (asc) - high priority first                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     DASHBOARD UI                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │  React Component: AgentMemorySearch                        │     │
│  │                                                             │     │
│  │  - InstantSearch integration                               │     │
│  │  - Faceted filtering by type, agent, status                │     │
│  │  - Highlighted search results                              │     │
│  │  - Links to source (bead detail, trail viewer, thread)     │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │  React Component: RelatedContextPanel                      │     │
│  │                                                             │     │
│  │  - Proactive suggestions (non-conversational)              │     │
│  │  - Shows related work when viewing agent/task              │     │
│  │  - "Similar past work", "Related decisions"                │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Schema

### Unified Index Record

```typescript
interface AgentWorkRecord {
  // Algolia required
  objectID: string;                    // Unique ID: "{type}_{source_id}"

  // Core searchable content
  title: string;                       // Primary display text
  content: string;                     // Full searchable body

  // Record classification
  type: 'message' | 'bead' | 'trail' | 'commit';

  // Temporal
  timestamp: number;                   // Unix timestamp (ms)

  // Attribution
  workspaceId: string;                 // Workspace scope
  agent?: string;                      // Agent who created this

  // Context
  thread?: string;                     // Conversation thread ID
  files?: string[];                    // Related file paths

  // Task linkage
  beadId?: string;                     // Link to bead (task)
  trajectoryId?: string;               // Link to trail
  commitSha?: string;                  // Link to git commit

  // For ranking/filtering
  status?: 'open' | 'in_progress' | 'completed' | 'closed';
  priority?: number;                   // 0-4 (0 = critical)
  confidence?: number;                 // 0-100 for decisions
  significance?: 'low' | 'medium' | 'high';

  // PDERO phase (for trails)
  phase?: 'problem' | 'design' | 'execution' | 'review' | 'optimize';
}
```

### Source-Specific Mappings

#### Messages → AgentWorkRecord

```typescript
function messageToRecord(msg: AgentMessage): AgentWorkRecord {
  return {
    objectID: `message_${msg.id}`,
    title: `${msg.fromAgent} → ${msg.toAgent}`,
    content: msg.body,
    type: 'message',
    timestamp: msg.messageTs.getTime(),
    workspaceId: msg.workspaceId,
    agent: msg.fromAgent,
    thread: msg.thread,
    status: msg.isBroadcast ? undefined : 'completed',
  };
}
```

#### Beads → AgentWorkRecord

```typescript
function beadToRecord(bead: BeadIssue): AgentWorkRecord {
  return {
    objectID: `bead_${bead.id}`,
    title: bead.title,
    content: bead.description || '',
    type: 'bead',
    timestamp: new Date(bead.created_at).getTime(),
    workspaceId: bead.workspace_id,
    agent: bead.assignee,
    beadId: bead.id,
    status: bead.status,
    priority: bead.priority,
  };
}
```

#### Trails → AgentWorkRecord

```typescript
function trailToRecord(trail: Trajectory): AgentWorkRecord {
  const decisions = trail.chapters
    .flatMap(c => c.events)
    .filter(e => e.type === 'decision');

  return {
    objectID: `trail_${trail.id}`,
    title: trail.task,
    content: [
      trail.retrospective?.summary,
      ...decisions.map(d => `${d.content}: ${d.reasoning}`),
    ].filter(Boolean).join('\n'),
    type: 'trail',
    timestamp: new Date(trail.completedAt).getTime(),
    workspaceId: trail.workspaceId,
    agent: trail.agents?.[0],
    trajectoryId: trail.id,
    confidence: trail.retrospective?.confidence
      ? Math.round(trail.retrospective.confidence * 100)
      : undefined,
    phase: trail.currentPhase,
  };
}
```

---

## Implementation Plan

### Phase 1: Algolia Setup (Day 1)

**Objective**: Create and configure Algolia index

#### Tasks

1. **Create Algolia Account**
   - Sign up for Algolia (Free Build Plan: 10K records, 10K searches/month)
   - Create application: `agent-relay-memory`

2. **Create Index**
   - Index name: `agent-work-history`
   - Configure searchable attributes:
     ```
     title
     content
     agent
     files
     ```
   - Configure facets:
     ```
     type
     status
     agent
     phase
     ```
   - Configure custom ranking:
     ```
     desc(timestamp)
     desc(confidence)
     asc(priority)
     ```

3. **Generate API Keys**
   - Admin key (for indexing) → store in `ALGOLIA_ADMIN_KEY`
   - Search-only key (for frontend) → store in `ALGOLIA_SEARCH_KEY`

#### Deliverables
- [ ] Algolia account created
- [ ] Index configured with proper settings
- [ ] API keys stored in environment

---

### Phase 2: Indexer Service (Days 2-3)

**Objective**: Build service to sync data to Algolia

#### File Structure

```
src/cloud/services/algolia/
├── index.ts              # Main exports
├── client.ts             # Algolia client setup
├── indexer.ts            # Main indexer service
├── transformers/
│   ├── messages.ts       # Message → AgentWorkRecord
│   ├── beads.ts          # Bead → AgentWorkRecord
│   └── trails.ts         # Trail → AgentWorkRecord
└── types.ts              # AgentWorkRecord type
```

#### Core Implementation

```typescript
// src/cloud/services/algolia/indexer.ts

import algoliasearch from 'algoliasearch';
import { db } from '../../db/index.js';
import { transformMessage } from './transformers/messages.js';
import type { AgentWorkRecord } from './types.js';

export class AlgoliaIndexer {
  private client: ReturnType<typeof algoliasearch>;
  private index: ReturnType<ReturnType<typeof algoliasearch>['initIndex']>;

  constructor() {
    this.client = algoliasearch(
      process.env.ALGOLIA_APP_ID!,
      process.env.ALGOLIA_ADMIN_KEY!
    );
    this.index = this.client.initIndex('agent-work-history');
  }

  /**
   * Sync unindexed messages to Algolia
   */
  async syncMessages(workspaceId: string, batchSize = 100): Promise<number> {
    const messages = await db.agentMessages.getUnindexed(workspaceId, batchSize);

    if (messages.length === 0) return 0;

    const records: AgentWorkRecord[] = messages.map(transformMessage);

    await this.index.saveObjects(records);
    await db.agentMessages.markIndexed(messages.map(m => m.id));

    return records.length;
  }

  /**
   * Full reindex of a workspace
   */
  async reindexWorkspace(workspaceId: string): Promise<void> {
    // Clear existing records for workspace
    await this.index.deleteBy({
      filters: `workspaceId:${workspaceId}`,
    });

    // Reindex all sources
    await this.syncMessages(workspaceId, 500);
    // await this.syncBeads(workspaceId);
    // await this.syncTrails(workspaceId);
  }

  /**
   * Search the index
   */
  async search(
    workspaceId: string,
    query: string,
    options?: { filters?: string; facets?: string[] }
  ) {
    return this.index.search(query, {
      filters: `workspaceId:${workspaceId}${options?.filters ? ` AND ${options.filters}` : ''}`,
      facets: options?.facets || ['type', 'agent', 'status'],
      attributesToHighlight: ['title', 'content'],
      highlightPreTag: '<mark>',
      highlightPostTag: '</mark>',
    });
  }
}
```

#### API Endpoints

```typescript
// src/cloud/api/search.ts

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { AlgoliaIndexer } from '../services/algolia/indexer.js';

export const searchRouter = Router();
const indexer = new AlgoliaIndexer();

/**
 * GET /api/search
 * Search agent work history
 */
searchRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const { q, type, agent, status } = req.query;
  const workspaceId = (req as any).user.workspaceId;

  const filters = [
    type && `type:${type}`,
    agent && `agent:${agent}`,
    status && `status:${status}`,
  ].filter(Boolean).join(' AND ');

  const results = await indexer.search(workspaceId, q as string, { filters });

  res.json(results);
});

/**
 * POST /api/search/reindex
 * Trigger full reindex (admin only)
 */
searchRouter.post('/reindex', requireAuth, async (req: Request, res: Response) => {
  const workspaceId = (req as any).user.workspaceId;

  await indexer.reindexWorkspace(workspaceId);

  res.json({ success: true });
});
```

#### Deliverables
- [ ] AlgoliaIndexer class implemented
- [ ] Message transformer implemented
- [ ] API endpoints for search and reindex
- [ ] Cron job for periodic sync (every 5 min)

---

### Phase 3: Dashboard Integration (Days 4-5)

**Objective**: Build search UI in dashboard

#### Components

```
src/dashboard/react-components/
├── search/
│   ├── AgentMemorySearch.tsx    # Main search interface
│   ├── SearchResultCard.tsx     # Individual result display
│   ├── SearchFacets.tsx         # Filter sidebar
│   └── RelatedContextPanel.tsx  # Proactive suggestions
```

#### Main Search Component

```tsx
// src/dashboard/react-components/search/AgentMemorySearch.tsx

import React, { useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';

interface SearchResult {
  objectID: string;
  title: string;
  content: string;
  type: 'message' | 'bead' | 'trail' | 'commit';
  agent?: string;
  timestamp: number;
  _highlightResult?: {
    title?: { value: string };
    content?: { value: string };
  };
}

export function AgentMemorySearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [facets, setFacets] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ type: '', agent: '', status: '' });

  const handleSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams({ q, ...filters });
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      setResults(data.hits);
      setFacets(data.facets);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  return (
    <div className="flex flex-col h-full bg-bg-deep">
      {/* Search Header */}
      <div className="p-4 border-b border-border-subtle">
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              handleSearch(e.target.value);
            }}
            placeholder="Search agent work history..."
            className="w-full px-4 py-3 pl-10 bg-bg-primary border border-border-subtle
                       rounded-lg text-text-primary placeholder-text-muted
                       focus:outline-none focus:border-accent-cyan focus:ring-1 focus:ring-accent-cyan"
          />
          <svg className="absolute left-3 top-3.5 w-5 h-5 text-text-muted" /* search icon */ />
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Facets Sidebar */}
        <div className="w-64 p-4 border-r border-border-subtle overflow-y-auto">
          <SearchFacets
            facets={facets}
            filters={filters}
            onChange={setFilters}
          />
        </div>

        {/* Results */}
        <div className="flex-1 p-4 overflow-y-auto">
          {loading ? (
            <div className="text-text-muted">Searching...</div>
          ) : results.length === 0 ? (
            <div className="text-text-muted">
              {query ? 'No results found' : 'Search for agent conversations, tasks, and decisions'}
            </div>
          ) : (
            <div className="space-y-4">
              {results.map((result) => (
                <SearchResultCard key={result.objectID} result={result} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

#### Result Card Component

```tsx
// src/dashboard/react-components/search/SearchResultCard.tsx

import React from 'react';

const TYPE_ICONS = {
  message: '💬',
  bead: '📋',
  trail: '🛤️',
  commit: '📝',
};

const TYPE_COLORS = {
  message: 'bg-blue-500/10 text-blue-400',
  bead: 'bg-green-500/10 text-green-400',
  trail: 'bg-purple-500/10 text-purple-400',
  commit: 'bg-orange-500/10 text-orange-400',
};

export function SearchResultCard({ result }: { result: SearchResult }) {
  const timeAgo = formatTimeAgo(result.timestamp);

  return (
    <div className="p-4 bg-bg-primary rounded-lg border border-border-subtle
                    hover:border-accent-cyan/50 transition-colors cursor-pointer">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[result.type]}`}>
          {TYPE_ICONS[result.type]} {result.type}
        </span>
        {result.agent && (
          <span className="text-xs text-text-muted">
            by {result.agent}
          </span>
        )}
        <span className="text-xs text-text-muted ml-auto">
          {timeAgo}
        </span>
      </div>

      {/* Title */}
      <h3
        className="font-medium text-text-primary mb-1"
        dangerouslySetInnerHTML={{
          __html: result._highlightResult?.title?.value || result.title
        }}
      />

      {/* Content Preview */}
      <p
        className="text-sm text-text-muted line-clamp-2"
        dangerouslySetInnerHTML={{
          __html: result._highlightResult?.content?.value || result.content
        }}
      />
    </div>
  );
}
```

#### Deliverables
- [ ] AgentMemorySearch component
- [ ] SearchResultCard component
- [ ] SearchFacets component
- [ ] RelatedContextPanel component (proactive suggestions)
- [ ] Integration with dashboard routing

---

### Phase 4: Agent Studio Integration (Day 6)

**Objective**: Create Algolia Agent for conversational queries

#### Agent Configuration

In Algolia Agent Studio dashboard:

1. **Create Agent**: "Agent Memory Assistant"

2. **System Prompt**:
   ```
   You are an Agent Memory Assistant for a software development team.
   You help developers find relevant past work, decisions, and conversations
   from the agent work history.

   When answering questions:
   - Search for relevant messages, tasks (beads), and decisions (trails)
   - Cite specific sources with their type and timestamp
   - Highlight confidence levels for decisions
   - Suggest related context the user might find useful

   Focus on the "why" behind code, not just the "what".
   ```

3. **Tools**: Enable Algolia Search on `agent-work-history` index

4. **Integration**:
   ```typescript
   // Optional: Add chat interface using AI SDK
   import { useChat } from "@ai-sdk/react";

   const { messages, sendMessage } = useChat({
     api: `https://${ALGOLIA_APP_ID}.algolia.net/agent-studio/1/agents/${AGENT_ID}/completions?stream=true`,
     headers: {
       'x-algolia-application-id': ALGOLIA_APP_ID,
       'x-algolia-api-key': ALGOLIA_SEARCH_KEY,
     }
   });
   ```

#### Deliverables
- [ ] Agent created in Agent Studio
- [ ] System prompt configured
- [ ] Optional chat UI component

---

### Phase 5: Polish & Demo (Day 7)

**Objective**: Prepare for competition submission

#### Tasks

1. **Seed Demo Data**
   - Populate with realistic agent conversations
   - Add variety of beads (tasks) with different statuses
   - Create trails with decisions and confidence scores

2. **Record Demo Video**
   - Show search across different data types
   - Demonstrate faceted filtering
   - Highlight proactive suggestions
   - Show Agent Studio conversation (if implemented)

3. **Write Submission**
   - Title: "Agent Memory: Search Your AI Team's Work History"
   - Category: Non-Conversational
   - Description emphasizing:
     - Novel corpus (agent reasoning, not just code)
     - Real-time sync from distributed daemons
     - Proactive context surfacing
     - Plan-based retention policies

#### Deliverables
- [ ] Demo data populated
- [ ] Demo video recorded (2-3 min)
- [ ] DEV.to submission posted

---

## Judging Criteria Alignment

| Criterion | How We Score |
|-----------|--------------|
| **Use of Algolia Technology** | Full pipeline: Real data → Algolia index → InstantSearch UI + optional Agent Studio |
| **User Experience** | Non-conversational proactive intelligence; instant search with facets and highlighting |
| **Originality** | First "agent memory" system—indexing reasoning and decisions, not just code |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Free tier limits (10K records) | Focus on recent data; implement aggressive dedup |
| No demo data | Create seed script with realistic conversations |
| Complex setup | Document all steps; use environment variables |
| Competition entry quality | Focus on polish; record professional demo video |

---

## Success Metrics

- [ ] Search returns results in <100ms
- [ ] All 4 data types (message, bead, trail, commit) searchable
- [ ] Faceted filtering works correctly
- [ ] Highlighting shows relevant matches
- [ ] Demo video clearly shows value proposition

---

## Timeline

| Day | Focus | Deliverables |
|-----|-------|--------------|
| 1 | Algolia Setup | Account, index, API keys |
| 2-3 | Indexer Service | AlgoliaIndexer, transformers, API |
| 4-5 | Dashboard UI | Search components, integration |
| 6 | Agent Studio | Optional chat agent |
| 7 | Polish & Submit | Demo video, submission |

---

## Appendix: Environment Variables

```bash
# Algolia Configuration
ALGOLIA_APP_ID=your_app_id
ALGOLIA_ADMIN_KEY=your_admin_key      # Server-side only
ALGOLIA_SEARCH_KEY=your_search_key    # Safe for frontend

# Index Configuration
ALGOLIA_INDEX_NAME=agent-work-history
```

---

## Appendix: Algolia Index Settings

```json
{
  "searchableAttributes": [
    "title",
    "content",
    "agent",
    "files"
  ],
  "attributesForFaceting": [
    "filterOnly(workspaceId)",
    "type",
    "status",
    "agent",
    "phase"
  ],
  "customRanking": [
    "desc(timestamp)",
    "desc(confidence)",
    "asc(priority)"
  ],
  "attributesToHighlight": [
    "title",
    "content"
  ],
  "highlightPreTag": "<mark>",
  "highlightPostTag": "</mark>",
  "hitsPerPage": 20
}
```
