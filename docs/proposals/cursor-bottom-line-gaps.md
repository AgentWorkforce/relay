# Bottom Line: What We're Actually Missing

**Date:** January 16, 2026
**Context:** Analysis of dormant code vs. integrated features

---

## TL;DR

We have **features that exist but aren't wired together or documented**. The real work is:

1. **Integration** - Hook up model selection (0.5 day)
2. **Documentation** - Make existing features discoverable (1 day)
3. **Testing** - Validate at scale before building more (1 day)
4. **Prompts** - Role-specific coordination patterns (2-3 days)

**Total to match Cursor's success: 4.5-5.5 days** (not 2 weeks)

---

## Gap Analysis: Code vs. Integration

### ✅ EXISTS + INTEGRATED

| Feature | Status | Evidence |
|---------|--------|----------|
| **StatelessLeadCoordinator** | Used by Supervisor | `src/resiliency/supervisor.ts` instantiates it |
| **ContinuityManager** | Singleton pattern | `getContinuityManager()` accessor exists |
| **Agent Profiles** | Parsed at spawn | `.claude/agents/*.md` frontmatter read |
| **Protocol Metadata** | In HelloPayload | `cli`, `program`, `model`, `task` fields exist |
| **Message Routing** | Core daemon | `->relay:` patterns fully functional |
| **Spawning** | Production-ready | `AgentSpawner` with PTY orchestration |

---

### ⚠️ EXISTS BUT NOT FULLY HOOKED UP

| Feature | Code Location | Integration Gap | Fix Effort |
|---------|---------------|-----------------|------------|
| **Consensus** | `src/daemon/consensus.ts` | `->relay:_consensus` documented but not in examples/guides | **2 hours** - Add to INTEGRATION-GUIDE.md |
| **Model Selection** | Protocol has `model` field | Spawner doesn't read `model:` from agent profiles | **4 hours** - Add profile parsing |
| **Continuity Commands** | `src/continuity/` | `->continuity:save/load` work but not in agent prompts | **2 hours** - Add to relay-protocol.md |
| **Role Field** | Not in protocol | HelloPayload missing `role` field | **2 hours** - Protocol extension |

---

### ❌ MISSING ENTIRELY

| Feature | Cursor Has | We Need | Effort |
|---------|-----------|---------|--------|
| **Role-specific prompts** | Planner/Worker/Judge prompts | `.claude/prompts/roles/` system | **2-3 days** |
| **Auto fresh starts** | Periodic restarts | Drift detector + auto-restart | **2 days** (builds on continuity) |
| **Optimistic concurrency** | Version-based writes | STATE_READ/WRITE protocol | **1 week** (complex) |

---

## What Cursor Actually Did (Bottom Line)

### 1. Made Hierarchy the Default ✅ (We can do this now)

**Cursor:** Planners spawn workers, workers don't spawn.

**Us:**
- StatelessLeadCoordinator exists ✅
- Lead agent profile exists ✅
- Worker agents exist ✅

**Gap:** No enforcement - any agent can spawn any agent.

**Fix:** Add `canSpawnChildren` boolean to profiles (2 hours)

---

### 2. Role-Specific Model Selection ⚠️ (Needs hookup)

**Cursor:** GPT-5.2 for planners, GPT-5.1-codex for workers.

**Us:**
- Protocol has `model` field ✅
- Agent profiles have `model:` frontmatter ✅
- Only 1/18 profiles specify model ❌
- Spawner doesn't read model from profile ❌

**Gap:** Model field exists but spawner ignores it.

**Fix:**
1. Read `model:` from profile frontmatter (2 hours)
2. Map model to CLI variant (`claude:sonnet`, `claude:opus`) (2 hours)
3. Update 18 agent profiles with appropriate models (1 hour)

**Total: 5 hours (0.5 day - confirmed estimate)**

---

### 3. Prompts > Architecture 🚨 (Real gap)

**Cursor:** "A surprising amount of the system's behavior comes down to how we prompt the agents"

**Us:**
- Basic relay protocol injected ✅
- Role-specific prompts don't exist ❌
- No prompt composition system ❌

**Gap:** This is the BIGGEST gap. We inject one static protocol doc, not role-specific strategies.

**Fix:**
1. Create `.claude/prompts/roles/` structure (1 hour)
2. Write 3 role prompts (planner, worker, reviewer) (8 hours)
3. Build PromptComposer to inject based on role (4 hours)
4. Test and iterate (4 hours)

**Total: 17 hours (2-3 days - confirmed estimate)**

---

### 4. Optimistic Concurrency 🤔 (Is it needed?)

**Cursor:** "Twenty agents would slow down to the effective throughput of two or three"

**Us:**
- File-based state (`workers.json`, `connected-agents.json`)
- No explicit locking
- ScalingOrchestrator uses Redis (different model)

**Question:** Do we have this bottleneck?

**Test First:** Spawn 20 agents, measure coordination overhead. If no bottleneck, skip this proposal entirely.

**If needed:** 1 week effort (complex protocol + daemon changes)

---

### 5. Fresh Starts 🤔 (Is it needed?)

**Cursor:** Periodic restarts to combat drift.

**Us:**
- Continuity handles handoffs ✅
- No automatic drift detection ❌
- No scheduled restarts ❌

**Question:** Do our agents actually drift in practice?

**Test First:** Run long-running agents (2+ hours), measure quality degradation. If no drift observed, skip this.

**If needed:** 2 days effort (builds on continuity)

---

## Bottom Line: 3 Actions, 4.5-5.5 Days

### Action 1: Integration (0.5 day)

**Make model selection work:**
1. Spawner reads `model:` from agent profiles
2. Map model to CLI command variant
3. Update 18 agent profiles with defaults

**Deliverable:** `->relay:spawn Lead claude:sonnet` uses Sonnet, `->relay:spawn Reviewer claude:opus` uses Opus

---

### Action 2: Documentation (1 day)

**Make existing features discoverable:**

1. **Update INTEGRATION-GUIDE.md** (3 hours)
   - How to use StatelessLeadCoordinator
   - How to use consensus for code reviews
   - How to use continuity for long tasks

2. **Update agent-relay-protocol.md** (2 hours)
   - Document `->continuity:save/load/search`
   - Document `->relay:_consensus PROPOSE/VOTE`
   - Add examples

3. **Create EXAMPLES.md** (3 hours)
   - Hierarchical planning example
   - Consensus code review example
   - Long-running task with continuity

**Deliverable:** Users know how to use features we already built

---

### Action 3: Role Prompts (2-3 days)

**Build prompt module system:**

1. **Prompt structure** (4 hours)
   - Create `.claude/prompts/roles/` directory
   - Define planner-strategy.md
   - Define worker-focus.md
   - Define reviewer-criteria.md

2. **Prompt composer** (4 hours)
   - Build PromptComposer class
   - Dynamic composition based on role
   - Integrate with spawner

3. **Test and iterate** (8-12 hours)
   - Spawn hierarchical team with prompts
   - Measure coordination improvement
   - Refine prompts based on behavior

**Deliverable:** Role-specific prompts that guide agent behavior

---

### Action 4: Test Before Building (1 day)

**Validate assumptions before investing in proposals 2 & 3:**

1. **Scale test** (3 hours)
   - Spawn 20 concurrent agents
   - Measure coordination overhead
   - Check for lock contention

2. **Drift test** (3 hours)
   - Run 3 agents for 2+ hours each
   - Measure output quality over time
   - Check for repetitive patterns

3. **Analysis** (2 hours)
   - Do we need optimistic concurrency?
   - Do we need automatic fresh starts?
   - Or are theoretical problems?

**Deliverable:** Evidence-based decision on proposals 2 & 3

---

## What This Gets Us

### With Actions 1-3 (4.5-5.5 days):

✅ **Hierarchical coordination** - Lead spawns workers with role enforcement
✅ **Role-based model selection** - Cost optimization + performance matching
✅ **Role-specific prompts** - Agents behave according to their role
✅ **Documentation** - Existing features are discoverable
✅ **Consensus** - Formalized multi-agent decisions
✅ **Continuity** - Cross-session state preservation

**Result:** We match Cursor's core capabilities with existing infrastructure + minor integration work.

---

### After Action 4 (Testing):

**If tests show bottlenecks:**
- Implement optimistic concurrency (1 week)
- Implement auto fresh starts (2 days)

**If tests show no issues:**
- Skip proposals 2 & 3 entirely
- Focus on other priorities

---

## Comparison: Theoretical vs. Practical

| Proposal | Original Analysis | Bottom Line Reality |
|----------|-------------------|---------------------|
| 1. Hierarchical Roles | "Need protocol extension" | **Just add `canSpawnChildren` to profiles** (2 hours) |
| 2. Optimistic Concurrency | "Essential for scale" | **Test first - may not be needed** (TBD) |
| 3. Auto Fresh Starts | "Combat drift" | **Test first - may not be needed** (TBD) |
| 4. Model Selection | "Medium complexity" | **Just wire up existing field** (5 hours) |
| 5. Role Prompts | "High impact" | **This is the real work** (2-3 days) |

---

## Recommendations

### Week 1: Integration + Documentation (1.5 days)
- Monday AM: Hook up model selection (0.5 day)
- Monday PM: Update documentation (0.5 day)
- Tuesday: Create examples + test guides (0.5 day)

### Week 1-2: Role Prompts (2-3 days)
- Tuesday PM: Create prompt structure (0.5 day)
- Wednesday: Write initial role prompts (1 day)
- Thursday: Build PromptComposer (0.5 day)
- Friday: Test and iterate (0.5-1.5 days)

### Week 2: Validation (1 day)
- Monday: Scale testing (0.5 day)
- Monday PM: Drift testing (0.5 day)
- Tuesday: Analyze results, decide on proposals 2 & 3

### Week 3+: Conditional
- **If tests show issues:** Implement proposals 2 & 3 (1-2 weeks)
- **If tests show no issues:** Move to other priorities

---

## Success Metrics

**After Week 1-2 (Actions 1-3):**
- [ ] 5+ hierarchical agent sessions in production
- [ ] Model selection reduces costs by 20%+ (Opus → Sonnet for routine tasks)
- [ ] Role prompts improve coordination (qualitative feedback)
- [ ] Existing features documented with examples

**After Week 2 (Action 4):**
- [ ] 20+ concurrent agents tested
- [ ] Coordination overhead measured (<100ms per message?)
- [ ] Long-running agent quality tracked (no degradation?)
- [ ] Evidence-based decision on proposals 2 & 3

---

## What We're NOT Missing

**Features we have that Cursor doesn't:**
- ✅ Consensus system (5 types)
- ✅ Cross-session continuity with search
- ✅ Multi-workspace orchestration
- ✅ Universal CLI support (not just GPT)
- ✅ Beads integration (dependency-aware task selection)
- ✅ Policy enforcement system
- ✅ Shadow agents
- ✅ Channel system

**These are differentiators, not gaps.**

---

## Final Answer to "What are we really missing?"

### Missing from Cursor's Playbook:

1. **Role-specific prompts** - The biggest gap (2-3 days)
2. **Model selection hookup** - Trivial integration (0.5 day)
3. **Documentation** - Features exist but not discoverable (1 day)

### Might Be Missing (Test First):

4. **Optimistic concurrency** - Test if we have lock bottlenecks
5. **Auto fresh starts** - Test if agents drift in practice

### Total to Match Cursor: 4.5-5.5 days of real work

**Everything else is polish, not MVP.**

---

*Analysis by: Lead agent*
*Date: January 16, 2026*
