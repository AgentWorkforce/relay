# Trajectory: Remove targeted fleet spawn token friction

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** August 20, 2026 at 11:27 PM
> **Completed:** August 20, 2026 at 11:36 PM

---

## Summary

Targeted fleet spawn now mints and deletes a short-lived workspace launcher when no agent token is present; added CLI coverage and changelog entry.

**Approach:** Standard approach

---

## Key Decisions

### Reuse workspace-scoped temporary launcher identity for every tokenless targeted spawn
- **Chose:** Reuse workspace-scoped temporary launcher identity for every tokenless targeted spawn
- **Reasoning:** The Daytona path already proves this authorization model and cleans up the identity in finally; extending it to named physical nodes removes the explicit token requirement without widening placement authority beyond the active workspace.

---

## Chapters

### 1. Work
*Agent: default*

- Reuse workspace-scoped temporary launcher identity for every tokenless targeted spawn: Reuse workspace-scoped temporary launcher identity for every tokenless targeted spawn
