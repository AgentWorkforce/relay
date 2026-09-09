# Trajectory: Add RelayFlow proof for workspace_busy startup admission

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 10, 2026 at 12:57 AM
> **Completed:** September 10, 2026 at 12:57 AM

---

## Summary

Added workspace-busy-startup-retry-429 RelayFlow proof covering baseline failure, head retry success, unrelated 429 terminal behavior, bounded exhaustion, and no whole-handshake replay.

**Approach:** Standard approach

---

## Key Decisions

### Used a dedicated real-broker RelayFlow case with an ephemeral HTTP admission server
- **Chose:** Used a dedicated real-broker RelayFlow case with an ephemeral HTTP admission server
- **Reasoning:** This gives deterministic base/head evidence for exact 429 workspace_busy behavior while checking unrelated 429 terminal handling and bounded request-scoped exhaustion without replaying registration.

---

## Chapters

### 1. Work
*Agent: default*

- Used a dedicated real-broker RelayFlow case with an ephemeral HTTP admission server: Used a dedicated real-broker RelayFlow case with an ephemeral HTTP admission server
- The cleanroom proof distinguishes the pre-fix terminal 429 from the retrying head and confirms unrelated throttles remain terminal; both compiled binaries passed their intended arm.
