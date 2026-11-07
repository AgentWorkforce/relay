# Trajectory: Implement #869 snapshot module + dump-pty command

> **Status:** ✅ Completed
> **Task:** ENG-869
> **Confidence:** 85%
> **Started:** May 17, 2026 at 10:19 AM
> **Completed:** May 17, 2026 at 10:33 AM

---

## Summary

Added snapshot module (capture / to_plain / to_ansi), GET /api/spawned/{name}/snapshot route, agent-relay-broker dump-pty CLI subcommand, and reference docs. Snapshot work routes through the PTY worker subprocess via snapshot_pty / snapshot_response frames keyed by request_id. 12 new tests, all 600 pass (was 588).

**Approach:** Standard approach

---

## Key Decisions

### Snapshot must execute in PTY worker subprocess, not broker

- **Chose:** Snapshot must execute in PTY worker subprocess, not broker
- **Reasoning:** PtySession lives in the spawned 'agent-relay-broker pty' subprocess. Broker only has stdin/stdout JSON-RPC pipes to it. So implement snapshot as: broker proxies via 'snapshot_pty' frame, worker responds with 'snapshot_response' frame, broker correlates by request_id.

### Built snapshot as a self-contained struct (rows/cols/cursor/cells), not a thin view over PtySession

- **Chose:** Built snapshot as a self-contained struct (rows/cols/cursor/cells), not a thin view over PtySession
- **Reasoning:** Capture walks the grid once under the term lock then drops it. Renderers run against owned data, so they cannot block the PTY reader thread or race with subsequent grid mutations. Simpler invariant for callers too: no lifetime juggling with the live session.

### Use a 5s timeout sweep for pending_snapshots to avoid stuck HTTP requests when a worker crashes

- **Chose:** Use a 5s timeout sweep for pending_snapshots to avoid stuck HTTP requests when a worker crashes
- **Reasoning:** Without a sweep, a snapshot request whose worker died between send and reply would block the HTTP handler's oneshot forever. The reap_tick loop fires every 500ms anyway, so piggy-backing is cheap.

---

## Chapters

### 1. Work

_Agent: default_

- Snapshot must execute in PTY worker subprocess, not broker: Snapshot must execute in PTY worker subprocess, not broker
- Built snapshot as a self-contained struct (rows/cols/cursor/cells), not a thin view over PtySession: Built snapshot as a self-contained struct (rows/cols/cursor/cells), not a thin view over PtySession
- Use a 5s timeout sweep for pending_snapshots to avoid stuck HTTP requests when a worker crashes: Use a 5s timeout sweep for pending_snapshots to avoid stuck HTTP requests when a worker crashes
