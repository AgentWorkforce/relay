# Trajectory: Replace 5-second message polling with long-poll endpoint in both relay-cloud and relay repos

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 13, 2026 at 03:17 PM
> **Completed:** February 13, 2026 at 03:19 PM

---

## Summary

Replaced 5-second interval polling with long-poll endpoint. Cloud side adds ?wait=N param that holds connection for up to 30s. Daemon side uses AbortController-based loop requesting with wait=25.

**Approach:** Standard approach

---

## Key Decisions

### Used server-side 500ms polling in long-poll endpoint rather than pub/sub
- **Chose:** Used server-side 500ms polling in long-poll endpoint rather than pub/sub
- **Reasoning:** Simple to implement with existing DB queries, no additional infrastructure needed, and 500ms polling is fast enough for the use case

---

## Chapters

### 1. Work
*Agent: default*

- Used server-side 500ms polling in long-poll endpoint rather than pub/sub: Used server-side 500ms polling in long-poll endpoint rather than pub/sub
