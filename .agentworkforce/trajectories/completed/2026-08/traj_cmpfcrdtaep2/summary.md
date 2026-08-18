# Trajectory: Repair standalone macOS package smoke handshake failure on PR 1572

> **Status:** ✅ Completed
> **Task:** PR-1572
> **Confidence:** 96%
> **Started:** August 18, 2026 at 07:57 PM
> **Completed:** August 18, 2026 at 09:58 PM

---

## Summary

Hardened fleet-node attach with a 90-second bounded control-plane retry budget, separately bounded WebSocket handshake/readiness recovery, stale-generation rejection, comprehensive deterministic tests, exact standalone package smoke, and live view/drive validation.

**Approach:** Standard approach

---

## Key Decisions

### Do not duplicate open PR 1567 into attach PR 1572
- **Chose:** Do not duplicate open PR 1567 into attach PR 1572
- **Reasoning:** PR 1567 already owns the standalone smoke workspace fix and passed that package check; cherry-picking it here would mix unrelated scopes and create a merge conflict. Rerun the failed job after backend health recovery and validate the final attach HEAD locally.

### Raise terminal-session POST timeout from 5s to 12s
- **Chose:** Raise terminal-session POST timeout from 5s to 12s
- **Reasoning:** The exact final binary failed live after 5s with control_plane_timeout, while production startup telemetry on the same backend has measured healthy 7.4-9.5s responses. A 12s bound accepts measured healthy latency, remains finite, and preserves the must-not-retry rule for ambiguous POST completion.

### Span one node heartbeat before exhausting reachability retries
- **Chose:** Span one node heartbeat before exhausting reachability retries
- **Reasoning:** The node emits liveness every 12s. Live testing with the existing 2s base delay reproduced the exact 503 twice in 20 attempts because all retries ended within about 6s. A 6s base yields deterministic 6s and 8s waits (14s total) while keeping three attempts and retrying only structured safe failures.

### Align initial attach recovery with the 31-second terminal recovery window
- **Chose:** Align initial attach recovery with the 31-second terminal recovery window
- **Reasoning:** A 14-second window still produced a structured node_unreachable 503 while query_nodes showed a fresh live heartbeat. Five attempts with deterministic delays totaling 31.2s remain bounded, match the established-session reconnect budget, and apply only to server-confirmed safe-to-retry failures.

### Use the standard 30-second Relay HTTP bound for session creation
- **Chose:** Use the standard 30-second Relay HTTP bound for session creation
- **Reasoning:** Live testing still hit an ambiguous client timeout at 12s. The broker already bounds Relaycast HTTP calls at 30s; matching that limit avoids prematurely abandoning a non-idempotent allocation POST while remaining finite and preserving the no-retry rule after unknown completion.

### Bound terminal-session creation to a 90-second aggregate deadline
- **Chose:** Bound terminal-session creation to a 90-second aggregate deadline
- **Reasoning:** A 30-second per-attempt timeout plus five retries could otherwise allocate roughly 181 seconds; the aggregate deadline preserves five immediate structured-safe retries while bounding ambiguous POST latency.

### Start terminal.ready timeout only after WebSocket open and reject stale ready frames
- **Chose:** Start terminal.ready timeout only after WebSocket open and reject stale ready frames
- **Reasoning:** HTTP upgrade and protocol readiness are separate phases; a late ready frame from an expired generation must not revive a dead connection.

### Make local readiness-gated requests follow all bounded reconnect generations
- **Chose:** Make local readiness-gated requests follow all bounded reconnect generations
- **Reasoning:** Snapshot, delivery-mode, and resize calls can begin during backoff; their wait budget must cover six backoffs plus each handshake and ready allowance rather than failing against a stale generation.

---

## Chapters

### 1. Work
*Agent: default*

- Do not duplicate open PR 1567 into attach PR 1572: Do not duplicate open PR 1567 into attach PR 1572
- Raise terminal-session POST timeout from 5s to 12s: Raise terminal-session POST timeout from 5s to 12s
- Span one node heartbeat before exhausting reachability retries: Span one node heartbeat before exhausting reachability retries
- Align initial attach recovery with the 31-second terminal recovery window: Align initial attach recovery with the 31-second terminal recovery window
- Use the standard 30-second Relay HTTP bound for session creation: Use the standard 30-second Relay HTTP bound for session creation
- Bound terminal-session creation to a 90-second aggregate deadline: Bound terminal-session creation to a 90-second aggregate deadline
- Start terminal.ready timeout only after WebSocket open and reject stale ready frames: Start terminal.ready timeout only after WebSocket open and reject stale ready frames
- Make local readiness-gated requests follow all bounded reconnect generations: Make local readiness-gated requests follow all bounded reconnect generations
- Final follow-up is based on current origin/main after PR 1572 and PR 1567 merged. Exact signed 11.7.1 artifacts passed the current workspace-reuse standalone smoke twice; live Finn validation passed view 20/20 and drive 10/10; focused tests passed 43/43 and independent Claude/Codex reviewers signed off.

---

## Artifacts

**Commits:** 59106aa93, 00f21bb78
**Files changed:** 14
