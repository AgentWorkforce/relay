# Wave Planner — Automatic Parallel Workflow Batching

## Problem

Agent-relay workflows today run sequentially by default. When a project has 60+ workflows, sequential execution takes 14+ hours even though many workflows are independent and could run in parallel. Manual wave grouping works but doesn't scale and requires human analysis of file overlap.

## Proposal

Add a **wave planner** to the agent-relay SDK that automatically analyzes workflow dependencies and groups independent workflows into parallel waves.

## How It Works

### 1. Static Analysis Phase

Before execution, the planner reads all workflow definitions and extracts:

```typescript
interface WorkflowFootprint {
  id: string;
  reads: string[];      // file globs this workflow reads
  writes: string[];     // file globs this workflow creates/modifies
  depends: string[];    // explicit dependsOn declarations
  packages: string[];   // which monorepo packages are touched
  category: string;     // inferred: 'frontend' | 'backend' | 'infra' | 'docs'
}
```

**Extraction methods:**
- Parse `step.command` for `find`, `cat`, `head` targets → reads
- Parse `step.task` for file paths mentioned in instructions → writes
- Parse `step.dependsOn` → explicit dependencies
- Infer package from file paths (`packages/web/*` → frontend, `packages/core/*` → backend)

### 2. Conflict Detection

Two workflows conflict if:
```
W1.writes ∩ W2.writes ≠ ∅   (write-write conflict)
W1.writes ∩ W2.reads ≠ ∅    (write-read conflict)
W1.reads ∩ W2.writes ≠ ∅    (read-write conflict)
```

Shared config files (`sst.config.ts`, `package.json`, `tsconfig.json`) are treated as **soft conflicts** — parallel execution is allowed but with a post-wave merge step.

### 3. Wave Generation

```typescript
function planWaves(workflows: WorkflowFootprint[]): Wave[] {
  const graph = buildConflictGraph(workflows);
  const waves: Wave[] = [];
  const scheduled = new Set<string>();

  while (scheduled.size < workflows.length) {
    const wave: WorkflowFootprint[] = [];
    
    for (const wf of workflows) {
      if (scheduled.has(wf.id)) continue;
      
      // Check: all explicit deps satisfied?
      if (!wf.depends.every(d => scheduled.has(d))) continue;
      
      // Check: no conflict with anything already in this wave?
      if (wave.some(w => conflicts(w, wf))) continue;
      
      wave.push(wf);
    }
    
    waves.push({ workflows: wave, maxConcurrency: wave.length });
    wave.forEach(w => scheduled.add(w.id));
  }
  
  return waves;
}
```

### 4. Execution

```bash
# User runs:
agent-relay run-all --parallel

# Or with explicit wave plan:
agent-relay plan workflows/*.ts --output waves.json
agent-relay run-waves waves.json
```

Each wave:
1. Spawns all workflows in the wave concurrently
2. Each gets its own broker, channel, and working directory
3. Waits for all to complete
4. Runs a **merge step** — auto-merges file changes, flags conflicts
5. Commits the wave
6. Proceeds to next wave

### 5. Merge Strategy

When parallel workflows modify the same file:
- **Non-overlapping changes**: Auto-merge (like git merge)
- **Overlapping changes**: Run a merge-resolver agent that reconciles conflicts
- **Shared configs** (package.json, tsconfig): Combine additions, flag contradictions

```typescript
interface WaveMergeResult {
  autoMerged: string[];           // files cleanly merged
  agentResolved: string[];        // files resolved by merge agent
  conflicts: string[];            // files needing human review
  commitMessage: string;          // auto-generated
}
```

## CLI Interface

```bash
# Analyze and show the plan
agent-relay plan workflows/*.ts
# Output:
# Wave 1 (4 parallel): 48-comparison, 49-feedback, 53-docs, 54-dark-mode
# Wave 2 (3 parallel): 50-security, 52-performance, 55-s3-storage
# Wave 3 (4 parallel): 51-a11y, 56-breakout-chat, 57-conversation, 58-activity
# Wave 4 (2 parallel): 59-relaycast, 60-shadcn
# Estimated time: 4 waves × ~35 min = ~2.5 hours (vs ~7 hours sequential)

# Execute the plan
agent-relay plan workflows/*.ts --run

# Override concurrency
agent-relay plan workflows/*.ts --run --max-concurrent 3

# Dry run — show what would happen
agent-relay plan workflows/*.ts --dry-run

# Manual wave override
agent-relay plan workflows/*.ts --wave "48,49,53,54" --wave "50,52,55" --run
```

## Config in Workflow Files

Workflow authors can declare hints:

```typescript
workflow('48-comparison-mode')
  .packages(['web', 'core'])              // which packages touched
  .isolatedFrom(['49-feedback-system'])    // safe to run in parallel with
  .requiresBefore(['46-admin-dashboard'])  // must run after
  .concurrencyGroup('frontend-features')  // manual grouping hint
```

## Smart Defaults

Without any hints, the planner uses heuristics:
- Workflows touching only `packages/web/src/app/X/` are isolated from workflows touching `packages/web/src/app/Y/`
- Workflows touching `packages/core/src/X/` are isolated from `packages/core/src/Y/`
- Workflows modifying `sst.config.ts`, root `package.json`, or `tsconfig` are soft-conflicted with everything
- Docs-only workflows (`53-documentation`) are always parallelizable

## Resource Management

```typescript
interface WaveRunnerConfig {
  maxConcurrency: number;       // max parallel workflows (default: CPU cores / 2)
  maxMemoryMB: number;          // kill workflows exceeding this (default: 2048)
  brokerStaggerMs: number;      // delay between broker starts (default: 3000)
  selfReviewTimeoutMs: number;  // kill hung self-reviews (default: 300000)
  commitAfterWave: boolean;     // auto-commit between waves (default: true)
  pushAfterWave: boolean;       // auto-push between waves (default: true)
}
```

## Impact

For Relayed's 60 workflows:
- **Sequential**: ~30 min × 60 = **30 hours**
- **Parallel waves**: ~12 waves × 35 min = **~7 hours** (4x faster)
- With optimized concurrency (8-way): **~4 hours** (7.5x faster)

## Implementation Plan

1. **Phase 1**: `agent-relay plan` command — static analysis + wave output (1-2 days)
2. **Phase 2**: `agent-relay run-waves` — parallel execution with per-wave commits (2-3 days)
3. **Phase 3**: Auto-merge strategy for shared files (2-3 days)
4. **Phase 4**: Workflow hints (`.packages()`, `.isolatedFrom()`) (1 day)
5. **Phase 5**: Resource management + OOM protection (1-2 days)

Total: ~2 weeks of focused work.
