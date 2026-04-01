# Trajectory: Fix intra-workspace messaging delivery and sidebar/notification visibility

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 7, 2026 at 03:03 PM
> **Completed:** January 7, 2026 at 03:11 PM

---

## Summary

Added WebSocket broadcast after message send to notify all workspace members in real-time

**Approach:** Standard approach

---

## Key Decisions

### Review: npm wrapper too narrow
- **Chose:** Review: npm wrapper too narrow
- **Reasoning:** Current wrapper only blocks 'npm install -g @openai/codex*' and fixed arg order; allow updates via other verbs/flag order

### Review: npm wrapper assumes /usr/local/bin/npm
- **Chose:** Review: npm wrapper assumes /usr/local/bin/npm
- **Reasoning:** Wrapper execs hardcoded path; safer to resolve via command -v to avoid breaking npm if location differs

---

## Chapters

### 1. Work
*Agent: default*

- Review: npm wrapper too narrow: Review: npm wrapper too narrow
- Review: npm wrapper assumes /usr/local/bin/npm: Review: npm wrapper assumes /usr/local/bin/npm
