# Trajectory: Tmux-Orchestrator competitive analysis

> **Status:** Completed
> **Task:** analyze-tmux-orchestrator
> **Started:** January 4, 2026 at 09:00 AM
> **Completed:** January 4, 2026 at 09:30 AM
> **Confidence:** 0.9

---

## Summary

Comprehensive competitive analysis of Tmux-Orchestrator vs Agent Relay, identified key features to adopt.

---

## Key Decisions

### 1. Continuity context already works on spawn - no new feature needed
- **Reasoning:** PtyWrapper.injectContinuityContext() already loads ledger + handoff and injects on agent spawn

### 2. Use trajectories for learnings instead of separate learning repository
- **Reasoning:** Trajectories already capture learnings via trail complete --learnings. Just need search functionality.

### 3. Self-scheduling is the key missing feature for 24/7 autonomy
- **Reasoning:** Tmux-Orchestrator's schedule_with_note.sh enables agents to wake themselves up. We need ->relay:schedule command.

### 4. Skip git commit tracking - requires git worktree architecture we don't have
- **Reasoning:** Tmux-Orchestrator's 30-minute commit rule assumes per-agent git worktrees. Not applicable to our current single-repo model.

---

## Learnings

1. **Tmux-Orchestrator pioneered 24/7 autonomous agent operation** using tmux persistence + self-scheduling

2. **Git commit tracking requires per-agent worktrees** - their 30-min rule isn't applicable without that architecture

3. **Fixed 3-tier hierarchy** (Orchestrator→PM→Engineer) solves context window limits but is less flexible than relay's any-topology approach

4. **Shell script + timing delays (~500ms)** is simpler but 100x slower than our Unix socket (<5ms)

5. **Self-scheduling with context notes** is the killer feature for autonomous operation

6. **Our continuity system already covers spawn context** - ledger + handoff injection works

7. **Trajectory learnings field already exists** - just need search/index functionality

---

## Chapters

### 1. Plan
*Agent: default*

- Fetched Tmux-Orchestrator README and CLAUDE.md from GitHub
- Reviewed existing competitive analyses format (GASTOWN.md, MCP_AGENT_MAIL.md)

### 2. Execute
*Agent: default*

- Created docs/competitive/TMUX_ORCHESTRATOR.md with full analysis
- Updated OVERVIEW.md comparison matrix with Tmux-Orchestrator
- Updated README.md with new analysis link

### 3. Execute
*Agent: default*

- Created 5 beads for features to adopt
- Reviewed existing continuity system - found spawn context already works
- Updated beads to reflect existing functionality

### 4. Review
*Agent: default*

- Confirmed PtyWrapper.injectContinuityContext() handles spawn context
- Confirmed trajectories already capture learnings field
- Identified self-scheduling as the truly new feature needed

---

## Beads Created

| ID | Priority | Feature | Status |
|----|----------|---------|--------|
| bd-tmux-sched1 | P0 | Self-scheduling (`->relay:schedule`) | New feature needed |
| bd-tmux-ctx1 | P1 | Structured spawn context | Enhancement (base works) |
| bd-tmux-esc1 | P1 | Escalation rules | New feature needed |
| bd-tmux-learn1 | P2 | Trajectory search | Enhancement (learnings exist) |

**Skipped:** Git commit tracking (bd-tmux-git1) - requires per-agent git worktrees

---

## Files Changed

- `docs/competitive/TMUX_ORCHESTRATOR.md` - New analysis (600+ lines)
- `docs/competitive/README.md` - Added to table
- `docs/competitive/OVERVIEW.md` - Added to comparison matrix
- `.beads/beads.jsonl` - 4 new beads (git tracking skipped)

---

*Trajectory completed 2026-01-04*
