# Trajectory: Investigate DM leakage into relay-dashboard message feed

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** March 11, 2026 at 11:16 AM
> **Completed:** March 11, 2026 at 11:23 AM

---

## Summary

Fixed relay-dashboard local feed leakage by filtering third-party private DMs out of selected-agent views and added regression tests

**Approach:** Standard approach

---

## Key Decisions

### Scoped the local agent feed to viewer-agent messages plus broadcasts
- **Chose:** Scoped the local agent feed to viewer-agent messages plus broadcasts
- **Reasoning:** Relaycast snapshots intentionally merge channel history and DMs, but the local useMessages hook was rendering any message involving the selected agent, including third-party private DMs. Filtering in the client preserves history access while preventing feed leakage.

---

## Chapters

### 1. Work
*Agent: default*

- Scoped the local agent feed to viewer-agent messages plus broadcasts: Scoped the local agent feed to viewer-agent messages plus broadcasts

---

## Artifacts

**Commits:** 75aa63ac, 54a556f8, dc846a21
**Files changed:** 15
