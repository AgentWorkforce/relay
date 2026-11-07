# Trajectory: Implement agent-relay view <name> read-only stream client (#864 sub-1)

> **Status:** ✅ Completed
> **Task:** ENG-864
> **Confidence:** 85%
> **Started:** May 17, 2026 at 10:02 PM
> **Completed:** May 17, 2026 at 10:05 PM

---

## Summary

Added agent-relay view <name> read-only PTY stream CLI. WS-based with worker_stream filter, ANSI preserved, Ctrl+C clean exit. 24 unit tests. Reused 'ws' SDK dep.

**Approach:** Standard approach

---

## Key Decisions

### Reuse 'ws' npm package — already a dep

- **Chose:** Reuse 'ws' npm package — already a dep
- **Reasoning:** The SDK already uses 'ws' v8.18.3 for the broker WebSocket transport. No new deps needed.

### DI-style command module with onSignal-based teardown

- **Chose:** DI-style command module with onSignal-based teardown
- **Reasoning:** Matches the project's testing.md convention; ExitSignal pattern lets us cleanly drive SIGINT in tests without actually exiting.

### Pure-function chunk filter (extractMatchingChunk) exported separately

- **Chose:** Pure-function chunk filter (extractMatchingChunk) exported separately
- **Reasoning:** Allows unit-testing the worker_stream filter without standing up a WebSocket or any I/O.

### Skip fresh-attach snapshot rendering

- **Chose:** Skip fresh-attach snapshot rendering
- **Reasoning:** Issue says nice-to-have; ship in follow-up. dump-pty already covers the use case manually.

---

## Chapters

### 1. Work

_Agent: default_

- Reuse 'ws' npm package — already a dep: Reuse 'ws' npm package — already a dep
- DI-style command module with onSignal-based teardown: DI-style command module with onSignal-based teardown
- Pure-function chunk filter (extractMatchingChunk) exported separately: Pure-function chunk filter (extractMatchingChunk) exported separately
- Skip fresh-attach snapshot rendering: Skip fresh-attach snapshot rendering
