# Trajectory: Design CLI-agnostic auto-continuity for lead agents

> **Status:** ✅ Completed
> **Task:** agent-relay-525
> **Confidence:** 85%
> **Started:** January 22, 2026 at 09:39 AM
> **Completed:** January 22, 2026 at 01:13 PM

---

## Summary

Completed Phase 5B: Extracted dashboard-server package, fixed CLI paths, added daemon/dashboard-server to build order, created backward-compatible shims. Build passes, 2796 tests passing.

**Approach:** Standard approach

---

## Key Decisions

### Use orchestrator layer for auto-continuity instead of CLI-specific hooks
- **Chose:** Use orchestrator layer for auto-continuity instead of CLI-specific hooks
- **Reasoning:** PreCompact hooks only exist in Claude Code. Codex, Gemini, Cursor have no equivalent. Orchestrator wraps all CLIs and sees all I/O, making it the right abstraction layer.

### Save state externally without agent cooperation
- **Chose:** Save state externally without agent cooperation
- **Reasoning:** Instead of injecting prompts asking agents to save their state, the orchestrator tracks state externally (messages, spawns, output). Zero agent involvement required - works transparently for any CLI.

### Use cycle-based triggers over time-based
- **Chose:** Use cycle-based triggers over time-based
- **Reasoning:** Cycles (messages, spawns, releases) are more meaningful than wall-clock time for coordination work. A lead that processes 50 messages in 5 minutes needs saves more than one idle for an hour.

### Use ring buffers for bounded memory
- **Chose:** Use ring buffers for bounded memory
- **Reasoning:** Keep last N messages and output chunks to bound memory usage while preserving enough context for recovery. Prevents unbounded growth in long-running agents.

### Add protocol monitoring to orchestrator that watches outbox for common mistakes
- **Chose:** Add protocol monitoring to orchestrator that watches outbox for common mistakes
- **Reasoning:** Agents sometimes have empty AGENT_RELAY_NAME or write files to wrong paths. Orchestrator now watches /tmp/relay-outbox/ and injects helpful reminders when issues are detected. Uses fs.watch with cooldown to avoid spam.

### Add periodic protocol reminders every 45 minutes for long sessions
- **Chose:** Add periodic protocol reminders every 45 minutes for long sessions
- **Reasoning:** Agents in long sessions sometimes forget the relay protocol. Periodic reminders at 45-minute intervals help them stay on track without user intervention. Includes comprehensive protocol reference with message format, special targets, spawning, and best practices.

### Completed Phase 5B dashboard-server extraction instead of CLI-agnostic continuity work
- **Chose:** Completed Phase 5B dashboard-server extraction instead of CLI-agnostic continuity work
- **Reasoning:** Session handoff prioritized completing Phase 5B extraction work from prior session

### Fixed CLI path references from dist/cli to dist/src/cli
- **Chose:** Fixed CLI path references from dist/cli to dist/src/cli
- **Reasoning:** TypeScript compiles with rootDir: . which outputs to dist/src/cli, not dist/cli

### Created @relay/dashboard-server package with transformed imports
- **Chose:** Created @relay/dashboard-server package with transformed imports
- **Reasoning:** Dashboard-server depends on daemon, bridge, cloud, wrapper - all transformed to package paths

---

## Chapters

### 1. Work
*Agent: default*

- Use orchestrator layer for auto-continuity instead of CLI-specific hooks: Use orchestrator layer for auto-continuity instead of CLI-specific hooks
- Save state externally without agent cooperation: Save state externally without agent cooperation
- Use cycle-based triggers over time-based: Use cycle-based triggers over time-based
- Use ring buffers for bounded memory: Use ring buffers for bounded memory
- Add protocol monitoring to orchestrator that watches outbox for common mistakes: Add protocol monitoring to orchestrator that watches outbox for common mistakes
- Add periodic protocol reminders every 45 minutes for long sessions: Add periodic protocol reminders every 45 minutes for long sessions
- Completed Phase 5B dashboard-server extraction instead of CLI-agnostic continuity work: Completed Phase 5B dashboard-server extraction instead of CLI-agnostic continuity work
- Fixed CLI path references from dist/cli to dist/src/cli: Fixed CLI path references from dist/cli to dist/src/cli
- Created @relay/dashboard-server package with transformed imports: Created @relay/dashboard-server package with transformed imports
