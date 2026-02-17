# Trajectory: Expose broker-sdk with logs, consensus, shadow, browser exports, and agent status query

> **Status:** ✅ Completed
> **Confidence:** 75%
> **Started:** February 17, 2026 at 10:40 AM
> **Completed:** February 17, 2026 at 10:46 AM

---

## Summary

Exposed broker-sdk via subpath exports with new consensus, shadow, logs, browser modules and Rust get_status command

**Approach:** Standard approach

---

## Key Decisions

### Split consensus into helpers (browser-safe) + engine (Node-only)
- **Chose:** Split consensus into helpers (browser-safe) + engine (Node-only)
- **Reasoning:** Browser export must avoid node:crypto and node:events at module load time

---

## Chapters

### 1. Work
*Agent: default*

- Split consensus into helpers (browser-safe) + engine (Node-only): Split consensus into helpers (browser-safe) + engine (Node-only)
