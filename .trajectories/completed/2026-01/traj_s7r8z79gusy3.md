# Trajectory: Fix relay-pty injection timeout - broadcast socket protocol redesign

> **Status:** ✅ Completed
> **Task:** PR-#216
> **Confidence:** 92%
> **Started:** January 18, 2026 at 05:44 PM
> **Completed:** January 18, 2026 at 05:45 PM

---

## Summary

Successfully fixed relay-pty injection timeout bug via broadcast-based socket protocol redesign. Root cause: socket connections closed before final 'delivered' response could be sent. Solution: keep connections open, stream all status updates (Queued→Injecting→Delivered) via broadcast channel. Implementation: 4-file changes (190 ins/99 del), all 30 tests passing, zero warnings. Team: RelayPtyFixer (implementation) + RelayPtyShadow (QA caught 3 critical issues). Known tradeoffs documented: acceptable for local usage (1-10 agents), monitoring needed for 100+ cloud deployment. PR #216 ready for merge. Impact: users no longer see 'Inject timeout' errors; responses arrive in 1-5 seconds instead of timing out at 30 seconds.

**Approach:** Standard approach

---

## Key Decisions

### Diagnosed root cause: socket connections close immediately after 'queued' response, final 'delivered' response discarded in main.rs
- **Chose:** Diagnosed root cause: socket connections close immediately after 'queued' response, final 'delivered' response discarded in main.rs
- **Reasoning:** 30-second timeout occurs because Node.js wrapper never receives the final response. Analysis of relay-pty/src/main.rs lines 353-355 showed responses were received but not forwarded to socket clients

### Chose Option A: broadcast-based response streaming with long-lived socket connections
- **Chose:** Chose Option A: broadcast-based response streaming with long-lived socket connections
- **Reasoning:** Evaluated 3 options: A (keep connection open + broadcast), B (client registry), C (broadcast all). Option A selected for simplicity, minimal code changes, and avoiding new architectural complexity. B was over-engineered; C was inefficient. A trades minor scalability concerns for clean implementation.

### Implemented pre-insertion pattern to prevent race condition in response routing
- **Chose:** Implemented pre-insertion pattern to prevent race condition in response routing
- **Reasoning:** If ID tracked AFTER enqueue, 'Queued' broadcast could arrive before tracking setup. Solution: insert ID into pending_ids BEFORE calling enqueue(). If enqueue fails, remove ID and send error. This prevents any missed responses. RelayPtyShadow identified this critical issue during review.

### Set broadcast channel capacity to 64 to handle concurrent injections
- **Chose:** Set broadcast channel capacity to 64 to handle concurrent injections
- **Reasoning:** Capacity of 64 sufficient for typical local agent-relay (1-10 agents). Would need monitoring/upgrade for 100+ concurrent agents. Logging warns on lag. If needed, easily configurable in main.rs line 174. Trade-off: simplicity vs. edge case handling.

### Spawned two-agent implementation: RelayPtyFixer (implementation) + RelayPtyShadow (quality review)
- **Chose:** Spawned two-agent implementation: RelayPtyFixer (implementation) + RelayPtyShadow (quality review)
- **Reasoning:** Complex Rust change required specialized expertise. RelayPtyFixer handled implementation (socket.rs rewrite, broadcast channel migration). RelayPtyShadow caught 3 critical issues upfront: memory leaks, race conditions, broadcast capacity. Parallel review prevented rework and ensured production quality.

### Accepted 6 known tradeoffs for production deployment
- **Chose:** Accepted 6 known tradeoffs for production deployment
- **Reasoning:** 1) Broadcast capacity drop at 64+ concurrent (LOW risk), 2) Longer connection lifetime (negligible resources), 3) Backpressure edge cases (handled), 4) Response matching at socket layer not protocol layer (simplicity tradeoff), 5) No scalability testing 100+ connections (acceptable for current use), 6) Potential socket write race (handled). Production-ready for local usage; would need upgrade path for 100+ agent cloud deployment.

### Implemented 4-file broadcast migration with 190 insertions/99 deletions
- **Chose:** Implemented 4-file broadcast migration with 190 insertions/99 deletions
- **Reasoning:** queue.rs: mpsc→broadcast channel + subscribe_responses() method. socket.rs: Major rewrite with tokio::select! multiplexing, pending ID tracking, response streaming. inject.rs: Sync broadcast calls. main.rs: Broadcast semantics. Migration clean, minimal, focused. All 30 tests pass, zero clippy warnings.

---

## Chapters

### 1. Work
*Agent: default*

- Diagnosed root cause: socket connections close immediately after 'queued' response, final 'delivered' response discarded in main.rs: Diagnosed root cause: socket connections close immediately after 'queued' response, final 'delivered' response discarded in main.rs
- Chose Option A: broadcast-based response streaming with long-lived socket connections: Chose Option A: broadcast-based response streaming with long-lived socket connections
- Implemented pre-insertion pattern to prevent race condition in response routing: Implemented pre-insertion pattern to prevent race condition in response routing
- Set broadcast channel capacity to 64 to handle concurrent injections: Set broadcast channel capacity to 64 to handle concurrent injections
- Spawned two-agent implementation: RelayPtyFixer (implementation) + RelayPtyShadow (quality review): Spawned two-agent implementation: RelayPtyFixer (implementation) + RelayPtyShadow (quality review)
- Accepted 6 known tradeoffs for production deployment: Accepted 6 known tradeoffs for production deployment
- Implemented 4-file broadcast migration with 190 insertions/99 deletions: Implemented 4-file broadcast migration with 190 insertions/99 deletions
