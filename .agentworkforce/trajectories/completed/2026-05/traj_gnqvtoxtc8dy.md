# Trajectory: Fix broker half-start recovery

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 19, 2026 at 02:34 PM
> **Completed:** May 19, 2026 at 02:47 PM

---

## Summary

Added deterministic recovery for detached broker half-starts by reaping unready broker PIDs and metadata-less foreground wrappers before restart, and by cleaning failed detached children on readiness timeout.

**Approach:** Standard approach

---

## Key Decisions

### Recover half-started detached brokers by killing foreground CLI wrappers and unready broker PIDs before retrying

- **Chose:** Recover half-started detached brokers by killing foreground CLI wrappers and unready broker PIDs before retrying
- **Reasoning:** The failure mode leaves a live agent-relay up --foreground process without usable connection metadata; scanning only agent-relay-broker misses that wrapper, so up/down --force must reap both wrapper and broker PID candidates.

---

## Chapters

### 1. Work

_Agent: default_

- Recover half-started detached brokers by killing foreground CLI wrappers and unready broker PIDs before retrying: Recover half-started detached brokers by killing foreground CLI wrappers and unready broker PIDs before retrying
