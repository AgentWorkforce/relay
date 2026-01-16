# Cursor Analysis: Existing Features Audit

**Addendum to:** `cursor-scaling-agents-analysis.md`
**Date:** January 16, 2026

---

## Purpose

This document audits what agent-relay **already has** vs. what's **net-new** in the Cursor proposals. The original analysis didn't fully account for existing infrastructure.

---

## What We Already Have

### 1. Hierarchical Coordination Infrastructure ✅

**Existing:**
- **`.claude/agents/lead.md`** - Lead agent pattern with coordination principles
- **`StatelessLeadCoordinator`** (`src/resiliency/stateless-lead.ts`)
  - Beads integration for task assignment
  - Leader heartbeat mechanism
  - Task leasing (P1 feature)
  - Stateless coordination (survives lead crashes)
- **Agent profiles** - 18+ role-specific profiles (architect, backend, frontend, fixer, etc.)
- **Spawn/release** - Basic hierarchical spawning via `AgentSpawner`

**Gap:**
- No protocol-level role enforcement
- Agents can spawn freely without role restrictions
- Dashboard doesn't visualize hierarchy

**Cursor Proposal 1 Impact:**
- **Builds on existing** - Formalizes existing patterns in protocol
- **Net-new** - Role-based spawn restrictions, hierarchy visualization
- **Effort reduced** - From 2-3 days to **1-2 days** (less than estimated)

---

### 2. State Management & Persistence ✅

**Existing:**
- **`AgentStateManager`** (`src/state/agent-state.ts`)
  - Persists agent context between spawns
  - `[[STATE]]` block parsing
  - `formatAsContext()` for prompt injection
- **Continuity system** (`src/continuity/`)
  - `ContinuityManager` - Session state management
  - `HandoffStore` - Cross-session handoffs
  - `LedgerStore` - State persistence
  - `->continuity:save/load/search` patterns
- **`[[SUMMARY]]` blocks** - Already parsed and tracked
- **Session persistence** - Cloud persistence service

**Gap:**
- No automatic drift detection
- No automatic fresh starts
- No context usage estimation

**Cursor Proposal 3 Impact:**
- **Builds heavily on existing** - Continuity system already does 80% of the work
- **Net-new** - Drift detector, context estimator, auto-restart triggers
- **Effort reduced** - From 3-4 days to **2 days** (continuity infrastructure exists)

---

### 3. Protocol Metadata Fields ✅

**Existing:**
`HelloPayload` in `src/protocol/types.ts`:
```typescript
interface HelloPayload {
  agent: string;
  cli?: string;           // Already exists!
  program?: string;       // Already exists!
  model?: string;         // Already exists!
  task?: string;          // Already exists!
  workingDirectory?: string;
  entityType?: 'agent' | 'user';
  // ... capabilities, session
}
```

**Gap:**
- No `role` field (planner/worker/reviewer)
- No `parentAgent` field for hierarchy tracking
- No `canSpawnChildren` boolean

**Cursor Proposal 1 Impact:**
- **Minimal protocol change** - Add 3 optional fields
- **No breaking changes** - All optional fields
- **Effort reduced** - Protocol extension is trivial

---

### 4. Consensus & Decision-Making ✅

**Existing:**
- **`ConsensusManager`** (`src/daemon/consensus.ts`)
  - 5 consensus types: majority, supermajority, unanimous, weighted, quorum
  - `->relay:_consensus` messaging patterns
  - PROPOSE, VOTE, VETO messages
  - Proposal tracking and resolution
  - Integration with daemon (`src/daemon/consensus-integration.ts`)
- **Cloud API** (`src/cloud/api/consensus.ts`) for web dashboard

**Gap:**
- Not mentioned in Cursor analysis at all!

**Cursor Proposals:**
- **No additional work needed** - We're ahead of Cursor here
- Cursor doesn't have consensus - we do

---

### 5. Multi-Workspace Orchestration ✅

**Existing:**
- **`Orchestrator`** (`src/daemon/orchestrator.ts`)
  - Multi-workspace daemon management
  - Workspace switching
  - Supervisor with auto-restart
  - Context persistence integration
- **`ScalingOrchestrator`** (`src/cloud/services/scaling-orchestrator.ts`)
  - Auto-scaler with policy evaluation
  - Capacity manager
  - Workspace provisioner
  - Redis coordination for cross-server state
  - Horizontal (scale up/down) and vertical (resize) scaling
  - Agent migration and rebalancing

**Gap:**
- Not using optimistic concurrency (file-based + Redis)

**Cursor Proposal 2 Impact:**
- **Partially exists** - ScalingOrchestrator uses Redis (closer to optimistic)
- **Net-new** - Versioned state store, STATE_READ/WRITE protocol messages
- **Effort remains** - Still ~1 week (complex change across daemon)

---

### 6. Agent Profiles & Configuration ✅

**Existing:**
- **`.claude/agents/*.md`** - 18+ agent profiles with frontmatter
- **Profile fields:**
  - `name`, `description`, `allowed-tools`, `skills`
  - **`model: sonnet`** - Already supported!
- **Spawner** reads profiles and applies config
- **Skills system** - `.claude/skills/` directory

**Gap:**
- Model field exists but not consistently used
- No role → model default mapping
- No CLI command variant selection

**Cursor Proposal 4 Impact:**
- **Mostly exists** - Infrastructure is there
- **Net-new** - Model → CLI command mapping, spawner logic
- **Effort reduced** - From 1-2 days to **0.5 day** (trivial integration)

---

### 7. Prompt Injection System ✅

**Existing:**
- **`--append-system-prompt`** - Claude Code flag
- **`agent-relay-protocol.md`** - Injected via prompt
- **`agent-relay-snippet.md`** - Shorter version
- **Agent profiles** - Can include custom instructions
- **Skills** - Can inject domain-specific prompts

**Gap:**
- No `.claude/prompts/` directory structure
- No role-specific prompt modules
- No dynamic prompt composition

**Cursor Proposal 5 Impact:**
- **Builds on existing** - Prompt injection infrastructure exists
- **Net-new** - Prompt module system, composition logic
- **Effort remains** - 2-3 days (content creation is the work)

---

## Revised Proposal Effort Estimates

| Proposal | Original Estimate | With Existing Features | Reduction |
|----------|-------------------|------------------------|-----------|
| 1. Hierarchical Roles | 2-3 days | **1-2 days** | -33% (StatelessLeadCoordinator, profiles exist) |
| 2. Optimistic Concurrency | 1 week | **1 week** | 0% (Still complex, Redis partial) |
| 3. Automatic Fresh Starts | 3-4 days | **2 days** | -50% (Continuity system exists) |
| 4. Role-Based Model Selection | 1-2 days | **0.5 day** | -63% (Model field exists, trivial mapping) |
| 5. Prompt-First Architecture | 2-3 days | **2-3 days** | 0% (Content creation is the work) |

**Total P0 Quick Wins:** Originally 3-5 days → **2.5-3.5 days** with existing features

---

## Features We Have That Cursor Doesn't

### 1. Consensus System ⭐

**What we have:**
- Multi-agent voting (5 consensus types)
- `->relay:_consensus` protocol integration
- Web dashboard for proposal tracking

**Cursor equivalent:** Not mentioned - they likely use manual coordination

**Advantage:** We can formalize multi-agent decisions that Cursor handles ad-hoc

---

### 2. Continuity System ⭐

**What we have:**
- Cross-session state persistence
- Handoff documents
- Searchable ledger with FTS5
- `->continuity:save/load/search`

**Cursor equivalent:** Periodic fresh starts (simpler)

**Advantage:** We preserve full context across restarts, not just periodic refreshes

---

### 3. Multi-Workspace Orchestration ⭐

**What we have:**
- Workspace isolation
- Cross-workspace agent coordination
- Scaling policies (horizontal + vertical)
- Resource tier management

**Cursor equivalent:** Not mentioned - likely single-workspace

**Advantage:** We can scale to multiple projects simultaneously

---

### 4. Universal CLI Support ⭐

**What we have:**
- Wrap any CLI (Claude, Codex, Gemini, Droid, OpenCode, Aider, Cursor, Cline)
- CLI auto-detection
- Output parsing (universal)

**Cursor equivalent:** GPT-5.x only

**Advantage:** Model heterogeneity - mix different providers in same team

---

### 5. Beads Integration ⭐

**What we have:**
- Task dependency tracking
- Priority-based work selection
- "Ready work" queue
- Stateless lead coordination

**Cursor equivalent:** Not mentioned

**Advantage:** External task management with dependency DAG

---

## Revised Recommendation

### Phase 0: Leverage Existing Features (1 day)

**Before building anything new**, maximize value from existing infrastructure:

1. **Document existing patterns** (2 hours)
   - Update CLAUDE.md to reference StatelessLeadCoordinator
   - Add consensus examples to docs
   - Showcase continuity system

2. **Create example workflows** (4 hours)
   - Lead spawns workers using existing patterns
   - Consensus-based code review
   - Continuity-based long-running tasks

3. **Test scaling** (2 hours)
   - Spawn 10+ agents with existing infrastructure
   - Measure coordination overhead
   - Identify real bottlenecks (not theoretical)

**Why:** Validate assumptions before building. Existing features may be sufficient.

---

### Phase 1: Quick Wins (2.5-3.5 days)

**Proposal 4 (0.5 day) + Proposal 5 (2-3 days)**

Updated effort estimates account for:
- Model field already in protocol
- Prompt injection infrastructure exists
- Agent profiles have frontmatter support

---

### Phase 2: Formalize Hierarchy (1-2 days)

**Proposal 1 - Updated estimate**

- Add 3 optional fields to HelloPayload
- Extend spawner to read `role` from profiles
- Dashboard hierarchy view (builds on existing UI)

---

### Phase 3: Auto-Restart (2 days)

**Proposal 3 - Updated estimate**

- Drift detector (new)
- Context estimator (new)
- Restart logic (builds on continuity)

---

### Phase 4: State Versioning (1 week)

**Proposal 2 - No change**

Still complex, but ScalingOrchestrator's Redis usage provides a foundation.

---

## Key Insights

### 1. We're More Feature-Complete Than Expected

The Cursor analysis underestimated existing infrastructure:
- Consensus ✅ (we have, Cursor doesn't)
- Continuity ✅ (advanced implementation)
- Multi-workspace ✅ (Cursor is single-workspace)
- StatelessLead ✅ (resilient coordination)

### 2. Quick Wins Are Even Quicker

**Proposal 4** is almost done - just need mapping logic.
**Proposal 1** has StatelessLeadCoordinator infrastructure.
**Proposal 3** has continuity system to build on.

### 3. Focus on Documentation & Examples

We may not need new features - we need **better examples** of existing features:
- How to use StatelessLeadCoordinator
- How to leverage consensus for code reviews
- How to structure long-running tasks with continuity

### 4. Test Before Building

**Action:** Spawn 20 agents with current infrastructure and measure:
- Coordination overhead
- Locking bottlenecks (do they actually exist?)
- Context drift (does it actually happen?)

Only build what's proven necessary.

---

## Updated Priority Matrix

| Priority | Proposal | Effort (Updated) | Rationale |
|----------|----------|------------------|-----------|
| **P-1** | Document existing features | 1 day | Unlock value already built |
| **P0** | 4. Role-Based Model Selection | 0.5 day | Trivial mapping logic |
| **P0** | 5. Prompt-First Architecture | 2-3 days | Content creation |
| **P1** | 1. Hierarchical Roles | 1-2 days | Formalize StatelessLead |
| **P2** | 3. Automatic Fresh Starts | 2 days | Build on continuity |
| **P2** | 2. Optimistic Concurrency | 1 week | Prove need first |

**Net Savings:** ~4-5 days vs. original estimates

---

## Conclusion

**The original Cursor analysis was correct in direction but underestimated existing infrastructure.**

### What Changes

1. **Effort reduced** - 3-5 days → 2.5-3.5 days for P0 quick wins
2. **Phase 0 added** - Document and test existing features first
3. **Validation step** - Prove need for Proposal 2 (optimistic concurrency) before building

### What Doesn't Change

- **Strategy** - Still start with prompts and model selection (P0)
- **Priority** - Still tackle hierarchy before advanced features
- **Philosophy** - Cursor's learnings are valid and applicable

### Action Items

1. **Immediate (today):**
   - Update `cursor-scaling-agents-analysis.md` to reference existing features
   - Test current infrastructure at scale (20+ agents)

2. **This week:**
   - Implement Proposal 4 (0.5 day)
   - Start Proposal 5 (2-3 days)

3. **Next week:**
   - Formalize hierarchy (Proposal 1)
   - Auto-restart (Proposal 3)

4. **Future:**
   - Optimistic concurrency (Proposal 2) - only if testing shows need

---

**Bottom Line:** We're further along than the original analysis suggested. Focus on **documenting** and **testing** what we have before building net-new features.

---

*Audit by: Lead agent*
*Date: January 16, 2026*
