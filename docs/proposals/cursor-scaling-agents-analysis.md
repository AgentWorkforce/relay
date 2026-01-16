# Cursor Scaling Agents: Analysis & Proposals for Agent Relay

**Source:** Cursor Engineering Blog - "Scaling Agents"
**Research Date:** January 2026
**Analysis Date:** January 16, 2026

> **⚠️ UPDATE:** See `cursor-analysis-existing-features-audit.md` for a comprehensive audit of what agent-relay already has. This addendum shows we're further along than originally estimated - many proposals build on existing infrastructure.

---

## Executive Summary

Cursor's engineering team documented their journey scaling multi-agent systems from peer-to-peer coordination to hierarchical pipelines. Their findings challenge conventional wisdom about agent architecture and provide actionable insights for agent-relay.

**Key Finding:** Prompts and model selection matter more than architectural sophistication.

**Recommendation:** Implement quick wins (proposals 4 & 5) first - role-based model selection and prompt-first architecture. These align with Cursor's core learnings and can be delivered in 3-5 days with high impact and low complexity.

---

## Part 1: Key Insights from Cursor's Experience

### 1. Hierarchical Pipeline > Flat Peer-to-Peer

**Cursor's Evolution:**
- **Before:** Flat peer-to-peer agent coordination
- **After:** Planner → Worker → Judge hierarchy

**Role Definitions:**
- **Planners:** Continuously explore codebase and create tasks. Can spawn sub-planners for specific areas, making planning itself parallel and recursive.
- **Workers:** Pick up tasks and focus entirely on completion. "They just grind on their assigned task until it's done."
- **Judges:** Evaluate cycle completion and determine whether to continue iterating.

**Why It Works:**
- Clear separation of concerns eliminates coordination overhead
- Workers don't waste cycles on meta-coordination
- Recursive planning (sub-planners) enables parallel exploration

**Agent Relay Parallel:**
- We have basic spawn/release but no role enforcement
- Lead agent pattern exists but isn't formalized in protocol
- No judge/reviewer role built-in

---

### 2. Optimistic Concurrency > Locks

**Cursor's Problem:**
Lock-based synchronization became a massive bottleneck:
- "Twenty agents would slow down to the effective throughput of two or three, with most time spent waiting"
- **Deadlock risks:** Agents could fail while holding locks, try to acquire locks they already held, or update coordination files without acquiring locks
- Critical sections serialized parallel work

**Cursor's Solution:**
Replaced locks with optimistic concurrency control:
- Agents read state freely (no blocking)
- Writes fail if state changed since last read
- Agent retries with fresh read on conflict
- Natural conflict resolution through retry

**Agent Relay Parallel:**
- We use file-based state (`workers.json`, `connected-agents.json`)
- Implicit locking via filesystem atomicity
- No explicit conflict detection or versioning
- ScalingOrchestrator uses Redis (closer to optimistic model)

---

### 3. Role Separation Eliminates Self-Coordination

**Cursor's Discovery:**
When agents self-coordinated in flat hierarchies, they became risk-averse:
- "They avoided difficult tasks and made small, safe changes instead"
- Spent cognitive cycles on "should I do this?" instead of "how do I do this?"
- Integrated quality-control roles "created more bottlenecks than it solved"

**Cursor's Solution:**
Explicit role separation removed coordination overhead entirely:
- Workers don't decide *what* to work on - they just execute
- Planners don't execute - they just decompose
- Judges don't plan or execute - they just evaluate

**Agent Relay Parallel:**
- We encourage Lead/Worker patterns but don't enforce
- No protocol-level role distinction
- Agents can spawn freely (no role-based restrictions)

---

### 4. Model Selection Matters by Role

**Cursor's Finding:**
Different AI models excel at different roles:
- **GPT-5.2** outperforms **GPT-5.1-codex** for planning, despite latter's coding specialization
- GPT-5.2 models are "much better at extended autonomous work: following instructions, keeping focus, avoiding drift"
- Role-specific model assignment improves overall system performance

**Implications:**
- Planning ≠ Coding (different cognitive demands)
- Long-running tasks need drift-resistant models
- Cost optimization opportunity (cheap models for simple tasks)

**Agent Relay Parallel:**
- Model specified at spawn time, not by role
- No role → model mapping
- All agents use same CLI (could vary model via args)

---

### 5. Prompt Engineering > Architecture Complexity

**Cursor's Core Lesson:**
> "A surprising amount of the system's behavior comes down to how we prompt the agents"

Key findings:
- Simpler systems with better prompts outperform theoretically sophisticated architectures
- The right amount of structure is somewhere in the middle:
  - Too little → agents conflict
  - Too much → fragility and brittleness
- Prompt iteration is faster than code iteration

**Agent Relay Parallel:**
- We inject `agent-relay-protocol.md` and `agent-relay-snippet.md` via `--append-system-prompt`
- Coordination patterns are partially hardcoded in wrappers
- Limited role-specific prompting
- Opportunity: externalize more behavior into prompts

---

### 6. Periodic Fresh Starts Combat Drift

**Cursor's Challenge:**
Long-running agents suffer from:
- Context pollution (accumulated cruft)
- Drift over time (losing focus)
- Accumulated errors (compounding mistakes)

**Cursor's Solution:**
Periodic fresh starts:
- Agents restart after threshold (time or context usage)
- State is preserved through handoff
- Workers handle conflict resolution autonomously

**Agent Relay Parallel:**
- Continuity system exists but is session-recovery focused
- No automatic drift detection
- No scheduled refresh/restart mechanism
- Opportunity: leverage existing continuity for automatic fresh starts

---

## Part 2: Proposals for Agent Relay

### Proposal 1: Hierarchical Agent Roles

**Priority:** P1 (High Impact, Medium Complexity)
**Estimated Effort:** 2-3 days

#### Current State
- Flat peer-to-peer messaging with basic spawn/release
- No role enforcement in protocol
- Agents can spawn freely without restrictions
- Dashboard shows flat agent list

#### Proposed Changes

**1. Protocol Extension**

Add to `HelloPayload` in `src/protocol/types.ts`:

```typescript
interface HelloPayload {
  agent: string;
  role?: 'planner' | 'worker' | 'reviewer' | 'coordinator'; // NEW
  parentAgent?: string;  // NEW - spawned by which agent?
  canSpawnChildren?: boolean;  // NEW - role-based restriction
  // ... existing fields
}
```

**2. Daemon Enforcement**

Add role-based spawn validation in `src/daemon/agent-daemon.ts`:

```typescript
// Reject spawn if agent's role doesn't allow children
if (sender.canSpawnChildren === false) {
  return this.sendError(connection, 'FORBIDDEN', 'Your role cannot spawn children');
}
```

**3. Agent Config Schema**

Extend `.claude/agents/*.md` frontmatter:

```yaml
---
name: Lead
role: planner
canSpawnChildren: true
model: claude-sonnet-4
---
```

**4. Dashboard Visualization**

Update dashboard to show hierarchical tree view:
- Indented list showing parent/child relationships
- Color-coded by role (planner, worker, reviewer)
- Expand/collapse agent subtrees

#### Benefits

1. **Enables hierarchical task decomposition**
   - Planners can spawn sub-planners (recursive exploration)
   - Workers prevented from spawning (reduces chaos)

2. **Clearer mental model**
   - Role indicates expected behavior
   - Dashboard visualization shows coordination structure

3. **Foundation for future features**
   - Role-based routing (e.g., `->relay:@planners`)
   - Role-specific rate limits
   - Hierarchical resource allocation

#### Trade-offs

**Pros:**
- Medium complexity - protocol change but backward compatible
- Builds on existing spawn infrastructure
- No breaking changes (new fields are optional)

**Cons:**
- Requires wrapper updates to pass role metadata
- Need to update all agent profile examples
- Additional validation logic in daemon

#### Implementation Plan

1. **Day 1:** Protocol types + daemon validation
2. **Day 2:** Wrapper updates + agent config parsing
3. **Day 3:** Dashboard hierarchy view + documentation

---

### Proposal 2: Optimistic Concurrency for Shared State

**Priority:** P2 (High Impact, High Complexity)
**Estimated Effort:** 1 week

#### Current State
- File-based state (`workers.json`, `connected-agents.json`)
- Implicit locking via filesystem operations
- No explicit conflict detection
- ScalingOrchestrator uses Redis (different model)

#### Proposed Changes

**1. New Protocol Messages**

Add to `src/protocol/types.ts`:

```typescript
interface StateReadPayload {
  key: string;  // e.g., 'workers', 'tasks'
}

interface StateWritePayload {
  key: string;
  value: unknown;
  expectedVersion: number;  // Version from last read
}

interface StateConflictPayload {
  key: string;
  currentVersion: number;
  yourVersion: number;
}

type MessageType =
  | 'STATE_READ'
  | 'STATE_WRITE'
  | 'STATE_CONFLICT'
  | /* ... existing types */;
```

**2. Versioned State Store**

Add to `src/storage/versioned-state.ts`:

```typescript
class VersionedStateStore {
  private state: Map<string, { value: unknown; version: number }>;

  read(key: string): { value: unknown; version: number } {
    // No locking - reads are always non-blocking
    return this.state.get(key) ?? { value: null, version: 0 };
  }

  write(key: string, value: unknown, expectedVersion: number): boolean {
    const current = this.state.get(key);

    // Conflict detection
    if (current && current.version !== expectedVersion) {
      return false;  // Write fails
    }

    // Optimistic write
    this.state.set(key, {
      value,
      version: (current?.version ?? 0) + 1,
    });
    return true;
  }
}
```

**3. Agent Retry Pattern**

Agents implement read-modify-write with retry:

```typescript
// Agent-side pattern
async function updateWorkerList(update: (list: Worker[]) => Worker[]) {
  let attempts = 0;
  while (attempts < 5) {
    const { value: workers, version } = await relay.stateRead('workers');
    const updated = update(workers);

    const success = await relay.stateWrite('workers', updated, version);
    if (success) return;

    // Conflict - retry with fresh read
    attempts++;
    await sleep(100 * attempts);  // Exponential backoff
  }
  throw new Error('Failed to update after 5 retries');
}
```

#### Benefits

1. **Eliminates deadlock risk**
   - No locks → no deadlock
   - Agents can't fail while holding locks

2. **Parallel work without blocking**
   - Multiple agents can read simultaneously
   - Writes only block on actual conflicts

3. **Natural conflict resolution**
   - Failed write → retry with fresh read
   - Eventually consistent

4. **Aligns with ScalingOrchestrator**
   - Redis already supports optimistic locking (WATCH/MULTI/EXEC)
   - Unified concurrency model across local and cloud

#### Trade-offs

**Pros:**
- Solves Cursor's #1 bottleneck
- Already partially exists in Redis-based orchestrator
- Scales to high agent counts

**Cons:**
- High complexity - new protocol messages and daemon logic
- Retry logic in agents (or wrapper abstraction)
- Requires careful versioning of all shared state
- Migration from file-based state

#### Implementation Plan

1. **Days 1-2:** Protocol types + VersionedStateStore implementation
2. **Days 3-4:** Daemon integration + Redis adapter
3. **Days 5-6:** Wrapper helper methods + agent patterns
4. **Day 7:** Migration guide + documentation

---

### Proposal 3: Automatic Fresh Starts for Long-Running Agents

**Priority:** P2 (Medium Impact, Medium Complexity)
**Estimated Effort:** 3-4 days

#### Current State
- Agents run until task completion or crash
- Continuity system exists for session recovery
- No automatic drift detection
- No scheduled refresh mechanism

#### Proposed Changes

**1. Configuration Options**

Add to wrapper config:

```typescript
interface WrapperConfig {
  // Existing fields...

  // NEW: Fresh start triggers
  freshStart?: {
    maxContextUsagePercent?: number;  // Default: 80%
    maxSessionDurationMs?: number;    // Default: 2 hours
    driftDetectionEnabled?: boolean;  // Default: true
  };
}
```

**2. Drift Detection**

Add to `src/wrapper/drift-detector.ts`:

```typescript
class DriftDetector {
  private recentOutputs: string[] = [];

  checkForDrift(output: string): boolean {
    this.recentOutputs.push(output);
    if (this.recentOutputs.length > 10) {
      this.recentOutputs.shift();
    }

    // Detect repetitive patterns
    const similarity = this.calculateSimilarity(this.recentOutputs);
    return similarity > 0.8;  // 80% similarity threshold
  }

  private calculateSimilarity(outputs: string[]): number {
    // Simple Jaccard similarity on word sets
    // More sophisticated: Levenshtein distance, embeddings
  }
}
```

**3. Automatic Handoff & Restart**

Add to `BaseWrapper`:

```typescript
async checkFreshStartTriggers() {
  const contextUsage = this.estimateContextUsage();
  const sessionDuration = Date.now() - this.startTime;
  const hasDrift = this.driftDetector.checkForDrift(this.recentOutput);

  const shouldRefresh =
    (contextUsage > this.config.freshStart.maxContextUsagePercent) ||
    (sessionDuration > this.config.freshStart.maxSessionDurationMs) ||
    (hasDrift && this.config.freshStart.driftDetectionEnabled);

  if (shouldRefresh) {
    await this.gracefulRestart();
  }
}

async gracefulRestart() {
  // 1. Save state via continuity
  await this.continuity.save({
    currentTask: this.currentTask,
    completedTasks: this.completedTasks,
    context: this.getCurrentContext(),
  }, { handoff: true });

  // 2. Stop current session
  await this.stop();

  // 3. Spawn fresh instance with same name
  await this.daemon.spawn({
    name: this.name,
    cli: this.cli,
    task: `Resume from handoff: ${this.continuity.lastHandoffId}`,
  });
}
```

**4. Context Usage Estimation**

Add token estimation:

```typescript
estimateContextUsage(): number {
  // Rough heuristic: 1 token ≈ 4 characters
  const totalChars = this.outputBuffer.join('').length;
  const estimatedTokens = totalChars / 4;

  // Assume 200k context window for Claude Sonnet 4
  const contextWindow = 200_000;
  return (estimatedTokens / contextWindow) * 100;
}
```

#### Benefits

1. **Combat context pollution**
   - Automatic cleanup before degradation
   - Fresh agent has clean slate

2. **Avoid accumulated drift**
   - Detect repetitive patterns
   - Restart before agent gets stuck

3. **Leverages existing infrastructure**
   - Builds on continuity/handoff system
   - No new protocol messages needed

4. **Configurable thresholds**
   - Users can tune sensitivity
   - Opt-out for short tasks

#### Trade-offs

**Pros:**
- Medium complexity - builds on existing continuity
- Addresses Cursor's drift problem
- Graceful handoff preserves work state

**Cons:**
- Risk: Restart at wrong time could lose context
- Drift detection heuristics may have false positives
- Adds restart overhead to long sessions

#### Implementation Plan

1. **Day 1:** Config schema + context estimation
2. **Day 2:** Drift detector implementation
3. **Day 3:** Graceful restart logic + continuity integration
4. **Day 4:** Testing + documentation

---

## Part 3: Quick Wins & Priority Matrix

### Proposal 4: Role-Based Model Selection ⭐ QUICK WIN

**Priority:** P0 (High Impact, Low Complexity)
**Estimated Effort:** 1-2 days

#### Current State
- All agents use same model, specified at spawn time
- No role → model mapping
- `.claude/agents/*.md` files exist but don't specify models

#### Proposed Changes

**1. Agent Profile Schema Extension**

Add `model` field to `.claude/agents/*.md`:

```yaml
---
name: Lead
role: planner
model: claude-sonnet-4
canSpawnChildren: true
---
```

```yaml
---
name: Worker
role: worker
model: claude-sonnet-4
canSpawnChildren: false
---
```

```yaml
---
name: Reviewer
role: reviewer
model: claude-opus-4  # More thorough, higher cost
canSpawnChildren: false
---
```

**2. Spawner Logic Update**

Modify `src/bridge/spawner.ts`:

```typescript
async spawn(request: SpawnRequest) {
  // Look up agent profile
  const profile = await this.loadAgentProfile(request.name);

  // Use model from profile, or fall back to request, or default
  const model = profile?.model ?? request.model ?? 'claude-sonnet-4';

  // Map model to CLI command variant
  const command = this.getCommandForModel(model);
  // e.g., 'claude:sonnet', 'claude:opus', 'codex', etc.

  // ... spawn with selected command
}
```

**3. Model → CLI Command Mapping**

Add to `src/utils/model-mapping.ts`:

```typescript
const MODEL_TO_CLI: Record<string, string> = {
  'claude-opus-4': 'claude:opus',
  'claude-sonnet-4': 'claude:sonnet',
  'claude-haiku-4': 'claude:haiku',
  'gpt-5.2': 'codex',  // If Codex uses GPT-5.2
  'gemini-2.5': 'gemini',
};

export function getCommandForModel(model: string): string {
  return MODEL_TO_CLI[model] ?? 'claude';  // Default fallback
}
```

**4. Cost Dashboard**

Add cost tracking to dashboard (optional enhancement):
- Track which models are being used
- Estimate cost per agent based on model
- Show total cost for session

#### Benefits

1. **Cost optimization**
   - Use cheaper models for simple tasks
   - Reserve expensive models for reviews

2. **Better performance matching**
   - Planning optimized models for planners
   - Code execution optimized for workers

3. **Builds on existing infrastructure**
   - Agent profiles already exist
   - Minimal code changes

4. **User-configurable**
   - Teams can tune cost/quality trade-off
   - Per-role customization

#### Trade-offs

**Pros:**
- Low complexity - extends existing config parsing
- No protocol changes
- Immediate value

**Cons:**
- Requires model availability (e.g., Opus access)
- Need cost/pricing consideration
- CLI variants must be installed

#### Implementation Plan

1. **Day 1:** Schema extension + model mapping + spawner logic
2. **Day 2:** Testing + documentation + example profiles

---

### Proposal 5: Prompt-First Architecture ⭐ QUICK WIN

**Priority:** P0 (High Impact, Low-Medium Complexity)
**Estimated Effort:** 2-3 days

#### Current State
- `agent-relay-protocol.md` injected via `--append-system-prompt`
- Some hardcoded behavior in wrappers (e.g., message injection timing)
- Limited role-specific prompting

#### Proposed Changes

**1. Prompt Module System**

Create `.claude/prompts/` directory structure:

```
.claude/prompts/
├── roles/
│   ├── planner-strategy.md      # How planners decompose tasks
│   ├── worker-focus.md           # Keep workers on-task
│   ├── reviewer-criteria.md     # What reviewers check
│   └── coordinator-patterns.md  # Coordination best practices
├── patterns/
│   ├── task-decomposition.md    # Templates for breaking down work
│   ├── error-recovery.md        # How to handle failures
│   └── conflict-resolution.md   # Resolving merge conflicts
└── context/
    ├── codebase-overview.md     # Project-specific context
    └── coding-standards.md      # Style/convention guidelines
```

**2. Dynamic Prompt Composition**

Add to `src/wrapper/prompt-composer.ts`:

```typescript
class PromptComposer {
  async composeForAgent(agent: AgentProfile, context: SessionContext): Promise<string> {
    const parts: string[] = [];

    // 1. Base protocol (always included)
    parts.push(await readFile('.claude/CLAUDE.md'));

    // 2. Role-specific strategy
    if (agent.role) {
      const rolePrompt = await this.loadRolePrompt(agent.role);
      if (rolePrompt) parts.push(rolePrompt);
    }

    // 3. Relevant patterns based on task
    if (context.task.includes('refactor')) {
      parts.push(await readFile('.claude/prompts/patterns/task-decomposition.md'));
    }

    // 4. Project-specific context
    parts.push(await readFile('.claude/prompts/context/codebase-overview.md'));

    return parts.join('\n\n---\n\n');
  }

  private async loadRolePrompt(role: string): Promise<string | null> {
    const path = `.claude/prompts/roles/${role}-strategy.md`;
    return await readFile(path).catch(() => null);
  }
}
```

**3. Example Role Prompts**

**`.claude/prompts/roles/planner-strategy.md`:**

```markdown
# Planner Strategy

You are a Planner agent. Your role is to:

1. **Explore the codebase** to understand structure and dependencies
2. **Decompose tasks** into parallel, independent units of work
3. **Spawn worker agents** to execute tasks
4. **Monitor progress** and adjust plans based on results

## Planning Principles

- **Break down, don't build up:** Start with smallest possible tasks
- **Parallelize aggressively:** If tasks are independent, run them concurrently
- **Avoid doing work yourself:** Your job is planning, not execution
- **Spawn sub-planners** for complex areas (e.g., "Plan authentication module")

## Task Decomposition Template

When given a task, structure your plan as:

1. **Analyze:** What needs to be done?
2. **Dependencies:** What must happen first?
3. **Decompose:** Break into 3-5 parallel tasks
4. **Spawn:** Create worker agents for each task
5. **Monitor:** Check in on progress, adjust as needed

## Anti-patterns

❌ Don't write code yourself - spawn a worker
❌ Don't create sequential tasks that could be parallel
❌ Don't micro-manage workers - let them execute autonomously
```

**`.claude/prompts/roles/worker-focus.md`:**

```markdown
# Worker Focus

You are a Worker agent. Your role is to:

1. **Execute your assigned task** completely and thoroughly
2. **Stay focused** - don't get distracted by other issues
3. **Report completion** when done
4. **Handle conflicts autonomously** - resolve merge conflicts without escalation

## Worker Principles

- **Grind on your task until done:** Don't switch contexts
- **Avoid meta-coordination:** You don't decide what to work on next
- **Trust your planner:** They decomposed this task for a reason
- **When stuck, ask for help:** Don't spin - escalate blockers

## Focus Techniques

- Read ONLY the files relevant to your task
- Ignore tempting refactors outside your scope
- Complete one thing well rather than starting multiple things

## Anti-patterns

❌ Don't propose new tasks - finish yours first
❌ Don't coordinate with other workers - let planners handle that
❌ Don't expand scope - stick to your assignment
```

**4. Prompt Injection via Wrapper**

Update `RelayPtyOrchestrator` to compose prompts:

```typescript
async start() {
  // Compose role-appropriate prompt
  const composedPrompt = await this.promptComposer.composeForAgent(
    this.agentProfile,
    this.sessionContext
  );

  // Inject via --append-system-prompt
  this.args.push('--append-system-prompt', composedPrompt);

  // ... continue spawn
}
```

#### Benefits

1. **Faster iteration**
   - Change prompts without touching code
   - A/B test coordination strategies

2. **User-customizable behavior**
   - Teams can adapt patterns to their workflow
   - Project-specific context injection

3. **Aligns with Cursor's key finding**
   - "A surprising amount of behavior comes down to prompts"
   - Lower complexity than architectural changes

4. **Easier debugging**
   - Behavior visible in prompt files
   - Version control prompt changes

#### Trade-offs

**Pros:**
- Low-medium complexity
- No protocol changes
- Immediate value, fast iteration

**Cons:**
- Prompt engineering is an art (trial and error)
- Need to balance prompt length vs. detail
- Requires maintenance as patterns evolve

#### Implementation Plan

1. **Day 1:** Prompt module structure + example role prompts
2. **Day 2:** PromptComposer implementation + wrapper integration
3. **Day 3:** Documentation + migration guide for existing patterns

---

## Priority Matrix

> **Note:** These estimates assume building from scratch. See `cursor-analysis-existing-features-audit.md` for updated estimates that account for existing infrastructure (StatelessLeadCoordinator, Continuity, Consensus, etc.). Actual effort is ~40% lower.

| Proposal                      | Impact | Complexity | Priority | Effort (Original) | Effort (Updated) | ROI  |
|-------------------------------|--------|------------|----------|-------------------|------------------|------|
| 4. Role-Based Model Selection | High   | Low        | **P0**   | 1-2 days | **0.5 day** | ⭐⭐⭐ |
| 5. Prompt-First Architecture  | High   | Medium     | **P0**   | 2-3 days | **2-3 days** | ⭐⭐⭐ |
| 1. Hierarchical Agent Roles   | High   | Medium     | **P1**   | 2-3 days | **1-2 days** | ⭐⭐  |
| 3. Automatic Fresh Starts     | Medium | Medium     | **P2**   | 3-4 days | **2 days** | ⭐⭐  |
| 2. Optimistic Concurrency     | High   | High       | **P2**   | 1 week   | **1 week** | ⭐   |

**Legend:**
- **P0:** Quick wins - high impact, low/medium complexity
- **P1:** High value - implement after P0
- **P2:** Important but complex - plan carefully

**Updated Total for P0 Quick Wins:** 2.5-3.5 days (down from 3-5 days)

---

## Diagnosis & Recommendations

### What Agent Relay Does Well

1. **Universal CLI wrapping** - Cursor is Claude-only; we support any CLI
2. **Real-time messaging** - <5ms via Unix sockets
3. **Existing infrastructure** - Agent profiles, continuity, spawning all work

### Where Cursor's Learnings Apply Directly

1. **Prompts matter most** ✅ Proposal 5 addresses this
2. **Model selection by role** ✅ Proposal 4 addresses this
3. **Hierarchical roles** ✅ Proposal 1 addresses this
4. **Optimistic concurrency** ⚠️ Proposal 2 is complex but valuable

### Where Agent Relay Can Differentiate

1. **Model heterogeneity** - Cursor uses GPT-5.x variants; we support Claude, GPT, Gemini, etc.
2. **Composability** - We're a messaging layer, not a complete solution
3. **Prompt customization** - Users can adapt patterns without forking

### Implementation Strategy

#### Phase 1: Quick Wins (Week 1)
**Proposals 4 & 5 - Total: 3-5 days**

Start here because:
- Aligns with Cursor's core finding (prompts > architecture)
- Low risk, high impact
- No protocol changes required
- Delivers immediate value

**Deliverables:**
- Role-based model selection working
- Prompt module system with 3 role prompts
- Documentation and examples

#### Phase 2: Hierarchical Coordination (Week 2)
**Proposal 1 - Total: 2-3 days**

After quick wins:
- Protocol extension for roles
- Dashboard hierarchy view
- Agent role enforcement

**Deliverables:**
- Hierarchical agent spawning
- Role-based spawn restrictions
- Dashboard tree view

#### Phase 3: Advanced Features (Week 3-4)
**Proposals 2 & 3 - Total: 10-11 days**

After foundations:
- Optimistic concurrency (1 week)
- Automatic fresh starts (3-4 days)

**Deliverables:**
- Versioned state store
- Drift detection
- Automatic handoff/restart

### Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Prompt changes break behavior | Version prompts, test suite, rollback capability |
| Model costs exceed budget | Cost tracking dashboard, per-role limits |
| Hierarchy too rigid | Make role field optional, gradual adoption |
| Optimistic conflicts too frequent | Exponential backoff, conflict rate monitoring |
| Fresh starts at wrong time | Configurable thresholds, opt-out per agent |

### Success Metrics

**Phase 1 (Quick Wins):**
- [ ] 3+ role prompts tested in production
- [ ] Cost reduction from model selection (measure baseline first)
- [ ] User feedback on prompt customization

**Phase 2 (Hierarchy):**
- [ ] 10+ agent sessions using hierarchical spawning
- [ ] Dashboard hierarchy view adoption
- [ ] Reduced coordination overhead (measure message volume)

**Phase 3 (Advanced):**
- [ ] Zero deadlocks with optimistic concurrency
- [ ] Fresh start rate < 5% of sessions (avoid thrashing)
- [ ] Context drift detection precision > 80%

---

## Conclusion

Cursor's experience validates our architecture (real-time messaging, hierarchical coordination) while highlighting areas for improvement (prompts, model selection, concurrency).

**Start with proposals 4 & 5** - they're low complexity, high impact, and align with Cursor's core finding that prompts and model selection matter more than architectural sophistication. This delivers value in 3-5 days and sets the foundation for hierarchical roles (proposal 1) and advanced features (proposals 2 & 3).

The key insight: **Agent Relay's composability is a strength.** We don't need to build everything Cursor built - we need to make it easy for users to compose role-specific agents with the right models and prompts.

---

**Next Steps:**

1. Review and prioritize these proposals with the team
2. Prototype proposal 4 (role-based model selection) - 1 day spike
3. Draft initial role prompts for proposal 5 - 1 day spike
4. Get user feedback on quick wins before investing in proposals 1-3

---

*Research Credit: Researcher agent*
*Analysis: Lead agent*
*Date: January 16, 2026*
