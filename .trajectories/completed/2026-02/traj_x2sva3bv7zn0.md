# Trajectory: Route all agent spawning through SDK/daemon instead of dashboard AgentSpawner

> **Status:** ✅ Completed
> **Task:** github-374
> **Confidence:** 85%
> **Started:** February 5, 2026 at 12:45 PM
> **Completed:** February 5, 2026 at 12:48 PM

---

## Summary

Routed all agent spawning through SDK/daemon, added SEND_INPUT and LIST_WORKERS protocol messages, refactored dashboard to use SpawnManagerLike for reads. Fixed fleet endpoints, spawn fallback policy bypass, spawnerName passthrough. Updated protocol/daemon/SDK docs.

**Approach:** Standard approach

---

## Key Decisions

### Three-layer refactor approach: protocol+SDK, daemon+wrapper, dashboard
- **Chose:** Three-layer refactor approach: protocol+SDK, daemon+wrapper, dashboard
- **Reasoning:** Need to thread spawn/release through every layer. Protocol types first (foundation), then SDK client methods + daemon handlers (Layer 1-2), then dashboard refactor (Layer 3). Each layer can be type-checked independently.

### Added SEND_INPUT and LIST_WORKERS protocol messages
- **Chose:** Added SEND_INPUT and LIST_WORKERS protocol messages
- **Reasoning:** Dashboard needs to read worker state (logs, hasWorker, getActiveWorkers) and send input to PTYs. These operations go through the daemon socket when using external SpawnManager, so need protocol-level support.

### SpawnManagerLike duck-typed interface instead of importing from daemon
- **Chose:** SpawnManagerLike duck-typed interface instead of importing from daemon
- **Reasoning:** Dashboard-server and daemon are separate packages. Using a duck-typed interface avoids a hard dependency on @agent-relay/daemon while still providing type-safe read operations (hasWorker, getActiveWorkers, getWorkerOutput, getWorkerRawOutput, sendWorkerInput).

### Daemon-first fallback chain: daemon socket → dashboard API → onSpawn callback
- **Chose:** Daemon-first fallback chain: daemon socket → dashboard API → onSpawn callback
- **Reasoning:** Daemon always has access to relay-pty binary (it resolves from its own install location). Dashboard API is second fallback for standalone mode. onSpawn callback is final fallback for custom spawn logic. Only fall through on transport errors, not on explicit daemon rejection (prevents policy bypass).

---

## Chapters

### 1. Work
*Agent: default*

- Three-layer refactor approach: protocol+SDK, daemon+wrapper, dashboard: Three-layer refactor approach: protocol+SDK, daemon+wrapper, dashboard
- Added SEND_INPUT and LIST_WORKERS protocol messages: Added SEND_INPUT and LIST_WORKERS protocol messages
- SpawnManagerLike duck-typed interface instead of importing from daemon: SpawnManagerLike duck-typed interface instead of importing from daemon
- Daemon-first fallback chain: daemon socket → dashboard API → onSpawn callback: Daemon-first fallback chain: daemon socket → dashboard API → onSpawn callback
