# Trajectory: Verify --broker-name override for agent-relay up

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 21, 2026 at 08:56 PM
> **Completed:** May 21, 2026 at 09:00 PM

---

## Summary

Verified the existing --broker-name implementation for agent-relay up, added detached-background regression coverage, and documented the flag in broker lifecycle/local-mode docs plus the changelog.

**Approach:** Standard approach

---

## Key Decisions

### Covered broker-name in detached up path

- **Chose:** Covered broker-name in detached up path
- **Reasoning:** Background mode reconstructs CLI args for a child process, so it needs explicit regression coverage separate from createRelay forwarding.

---

## Chapters

### 1. Work

_Agent: default_

- Covered broker-name in detached up path: Covered broker-name in detached up path
