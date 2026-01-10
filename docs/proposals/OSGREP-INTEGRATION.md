# Proposal: osgrep Integration for Semantic Code Search

**Status**: Draft
**Author**: Claude
**Date**: 2026-01-10
**Supersedes**: TLDR-INTEGRATION.md (partially - structural analysis deferred)

## Executive Summary

Integrate [osgrep](https://github.com/Ryandonofrio3/osgrep) as the semantic code search backend for agent-relay. osgrep is a TypeScript-native tool that provides semantic search with local embeddings, requiring no API keys and adding ~150MB (vs llm-tldr's 2GB Python/PyTorch stack).

## Why osgrep Over llm-tldr

| Factor | llm-tldr | osgrep | Winner |
|--------|----------|--------|--------|
| Language | Python | TypeScript | osgrep |
| Install Size | ~2GB | ~150MB | osgrep |
| Runtime | Python 3.10+ | Node.js | osgrep |
| API Keys | None | None | Tie |
| Embeddings | PyTorch | ONNX | osgrep |
| Community | Newer | 933 stars | osgrep |
| HTTP Server | No | Yes (`serve`) | osgrep |
| Call Graphs | Yes | Basic (`trace`) | llm-tldr |
| Data Flow | Yes | No | llm-tldr |

**Decision**: Use osgrep for semantic search. Defer structural analysis (call graphs, data flow) pending agent feedback on whether it's needed.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Relay Daemon                        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    CodeSearchService                      │   │
│  │  ├─ HTTP client to osgrep serve                          │   │
│  │  ├─ ->relay:code pattern handler                         │   │
│  │  └─ Startup context injection                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                         │
│  │ Agent A │  │ Agent B │  │ Agent C │                         │
│  └─────────┘  └─────────┘  └─────────┘                         │
└─────────────────────────────────────────────────────────────────┘
         │
         │ HTTP (localhost:3456)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      osgrep serve                                │
│  ├─ LanceDB vector index (hot in RAM)                           │
│  ├─ ONNX embeddings (local, no API)                             │
│  ├─ File watcher (auto re-index on changes)                     │
│  └─ POST /search, GET /health                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Integration Points

### 1. Agent Pattern: `->relay:code`

```
->relay:code search "authentication middleware"
->relay:code search "JWT validation" --limit 10
->relay:code trace handleLogin
->relay:code skeleton src/auth/
```

### 2. Startup Context Injection

On agent session start, auto-query osgrep for task-relevant code:

```typescript
// src/hooks/session-start.ts
async function injectCodeContext(task: string, projectPath: string): Promise<string> {
  const osgrep = new OsGrepClient();

  // Search for code related to the task
  const results = await osgrep.search(task, { limit: 5 });

  if (results.length === 0) return '';

  return `
## Relevant Code (auto-discovered via osgrep)

${results.map(r => `- \`${r.file}:${r.line}\` - ${r.signature}`).join('\n')}

Use \`->relay:code search "query"\` for more semantic search.
`;
}
```

### 3. HTTP Client

```typescript
// src/services/osgrep-client.ts
import http from 'node:http';

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  score: number;
  role?: 'definition' | 'test' | 'config';
}

export interface OsGrepClientOptions {
  baseUrl?: string;
  timeout?: number;
  keepAlive?: boolean;
}

export class OsGrepClient {
  private baseUrl: string;
  private agent: http.Agent;
  private timeout: number;

  constructor(options: OsGrepClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:3456';
    this.timeout = options.timeout ?? 30000;
    this.agent = new http.Agent({
      keepAlive: options.keepAlive ?? true,
      maxSockets: 5,
    });
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async search(
    query: string,
    options: { limit?: number; path?: string } = {}
  ): Promise<SearchResult[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        limit: options.limit ?? 10,
        path: options.path,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!res.ok) {
      throw new Error(`osgrep search failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return data.results;
  }

  async isAvailable(): Promise<{ available: boolean; suggestion?: string }> {
    if (await this.health()) {
      return { available: true };
    }

    return {
      available: false,
      suggestion: 'Start osgrep with: osgrep serve --background',
    };
  }
}
```

### 4. Parser Extension

```typescript
// src/wrapper/parser.ts (additions)

const CODE_PATTERN = /^->relay:code\s+(\w+)\s*(.*)$/;

export interface CodeCommand {
  action: 'search' | 'trace' | 'skeleton';
  query: string;
  options: Record<string, string | number | boolean>;
}

export function parseCodeCommand(line: string): CodeCommand | null {
  const match = line.match(CODE_PATTERN);
  if (!match) return null;

  const [, action, argsString] = match;
  const { positional, flags } = parseArgs(argsString);

  return {
    action: action as CodeCommand['action'],
    query: positional[0] ?? '',
    options: flags,
  };
}

function parseArgs(argsString: string): { positional: string[]; flags: Record<string, any> } {
  const tokens = tokenize(argsString);
  const positional: string[] = [];
  const flags: Record<string, any> = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = parseValue(next);
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }

  return { positional, flags };
}
```

### 5. Service Handler

```typescript
// src/services/code-search-service.ts

import { OsGrepClient, SearchResult } from './osgrep-client.js';
import { CodeCommand } from '../wrapper/parser.js';

export class CodeSearchService {
  private client: OsGrepClient;
  private available: boolean = false;

  constructor() {
    this.client = new OsGrepClient();
  }

  async init(): Promise<void> {
    const status = await this.client.isAvailable();
    this.available = status.available;

    if (!this.available) {
      console.warn(`[code-search] osgrep not available: ${status.suggestion}`);
    }
  }

  async handleCommand(cmd: CodeCommand): Promise<string> {
    if (!this.available) {
      return this.formatUnavailable();
    }

    switch (cmd.action) {
      case 'search':
        return this.handleSearch(cmd.query, cmd.options);
      case 'trace':
        return this.handleTrace(cmd.query);
      case 'skeleton':
        return this.handleSkeleton(cmd.query);
      default:
        return `Unknown code command: ${cmd.action}`;
    }
  }

  private async handleSearch(query: string, options: Record<string, any>): Promise<string> {
    const results = await this.client.search(query, {
      limit: options.limit ?? 10,
      path: options.path,
    });

    if (results.length === 0) {
      return `No results found for: "${query}"`;
    }

    return this.formatResults(results);
  }

  private formatResults(results: SearchResult[]): string {
    const lines = results.map((r, i) => {
      const score = r.score ? ` (${(r.score * 100).toFixed(0)}%)` : '';
      return `${i + 1}. ${r.file}:${r.line}${score}\n   ${r.content.trim().slice(0, 100)}`;
    });

    return `## Search Results\n\n${lines.join('\n\n')}`;
  }

  private formatUnavailable(): string {
    return `
[code search unavailable]

osgrep is not running. Start it with:
  osgrep serve --background

Or install with:
  npm install -g osgrep
  osgrep setup
  osgrep serve --background
`.trim();
  }

  private async handleTrace(target: string): Promise<string> {
    // osgrep trace command - shows call relationships
    // TODO: Implement when we add trace support
    return `Trace not yet implemented. Use: osgrep trace ${target}`;
  }

  private async handleSkeleton(path: string): Promise<string> {
    // osgrep skeleton - shows structure without implementation
    // TODO: Implement when we add skeleton support
    return `Skeleton not yet implemented. Use: osgrep search --skeleton ${path}`;
  }
}
```

## Setup & Dependencies

### User Setup

```bash
# One-time installation
npm install -g osgrep
osgrep setup  # Downloads ~150MB embedding model

# Per-project (run in background)
cd /path/to/project
osgrep serve --background
```

### Relay Daemon Integration

```typescript
// src/daemon/server.ts (additions)

import { CodeSearchService } from '../services/code-search-service.js';

export class Daemon {
  private codeSearch: CodeSearchService;

  async start(): Promise<void> {
    // ... existing startup ...

    // Initialize code search
    this.codeSearch = new CodeSearchService();
    await this.codeSearch.init();
  }
}
```

## Agent Discovery & Enforcement

### How Agents Learn About Code Search

1. **CLAUDE.md snippet** (already in relay):
```markdown
## Code Search

Use `->relay:code search "query"` for semantic code search.
Examples:
  ->relay:code search "authentication middleware"
  ->relay:code search "database connection pooling"
  ->relay:code trace handleLogin
```

2. **Startup context injection** (automatic)
3. **Lead agent instructions** (when delegating tasks)

### Enforcement Strategy

We don't strictly enforce - we make it easy and visible:

| Mechanism | Description |
|-----------|-------------|
| Startup injection | Agents see relevant code before they ask |
| Pattern recognition | `->relay:code` is natural extension of existing patterns |
| Lead delegation | Lead tells workers to use code search |
| Retrospective feedback | Ask agents if they needed structural analysis |

## Latency & Performance

| Metric | Target | osgrep Actual |
|--------|--------|---------------|
| Health check | <10ms | ~5ms |
| Search (hot) | <100ms | ~50ms |
| Search (cold) | <500ms | ~200ms |
| Index time (10K files) | <5min | ~2-3min |

### Optimization: Keep-Alive Connections

```typescript
// Reuse HTTP connections
const agent = new http.Agent({ keepAlive: true, maxSockets: 5 });

// Results in ~35ms instead of ~50ms for repeated queries
```

## Migration from llm-tldr Proposal

The TLDR-INTEGRATION.md proposal remains valid for structural analysis (call graphs, data flow, impact analysis). This proposal covers semantic search only.

**Decision tree**:
```
Need semantic code search?
  └─ Yes → Use osgrep (this proposal)

Need structural analysis (call graphs, impact)?
  └─ Yes → Evaluate based on agent feedback
      ├─ High demand → Build @agent-relay/code-graph (2-3 weeks)
      └─ Low demand → Defer indefinitely
```

## Rollout Plan

### Phase 1: Documentation (Day 1)
- [ ] Add osgrep setup to README
- [ ] Add `->relay:code` pattern to CLAUDE.md
- [ ] Document in getting started guide

### Phase 2: Client Implementation (Week 1)
- [ ] Implement `OsGrepClient`
- [ ] Add `->relay:code` pattern parsing
- [ ] Add `CodeSearchService`
- [ ] Write tests

### Phase 3: Daemon Integration (Week 2)
- [ ] Integrate service into daemon startup
- [ ] Add health check to status command
- [ ] Add startup context injection hook

### Phase 4: Feedback Collection (Ongoing)
- [ ] Add retrospective question about structural analysis need
- [ ] Track code search usage metrics
- [ ] Decide on call graph implementation based on feedback

## Success Metrics

| Metric | Target |
|--------|--------|
| osgrep adoption | >50% of sessions use `->relay:code` |
| Search latency P95 | <100ms |
| Agent satisfaction | Positive feedback in retros |
| File read reduction | 20% fewer raw file reads |

## Open Questions

1. **Should we auto-start osgrep?**
   - Pro: Better UX
   - Con: Background process management complexity

2. **Index sharing across agents?**
   - Single osgrep instance per project
   - All agents query the same index

3. **When to build call graph layer?**
   - Defer until agent retros indicate need
   - Track "I wish I knew what calls X" feedback

## Appendix: osgrep CLI Reference

```bash
# Setup (one-time)
osgrep setup                    # Download embedding model

# Indexing
osgrep index                    # Index current directory
osgrep index --verbose          # Show progress
osgrep index --reset            # Full re-index

# Searching
osgrep "query"                  # Semantic search
osgrep "query" -m 20            # Limit results
osgrep "query" --scores         # Show relevance scores
osgrep "query" --compact        # Compact output

# Server mode
osgrep serve                    # Start HTTP server (foreground)
osgrep serve --background       # Start as daemon
osgrep serve --port 3456        # Custom port
osgrep serve status             # Check running servers
osgrep serve stop               # Stop all servers

# HTTP API
POST /search { "query": "...", "limit": 10 }
GET /health
```
