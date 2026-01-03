# Trajectory: Switch from GitHub OAuth to GitHub App for repo access

> **Status:** ✅ Completed
> **Task:** agent-relay-324
> **Confidence:** 85%
> **Started:** January 2, 2026 at 10:18 PM
> **Completed:** January 2, 2026 at 10:55 PM

---

## Summary

Implemented GitHub App API routes and config for agent-relay-324

**Approach:** Standard approach

---

## Key Decisions

### Parser fix already implemented
- **Chose:** Parser fix already implemented
- **Reasoning:** Verified PLACEHOLDER_TARGETS set and isPlaceholderTarget() function are in place with 4 call sites. All 136 tests pass.

### Implemented GitHub App directly instead of using Nango
- **Chose:** Implemented GitHub App directly instead of using Nango
- **Reasoning:** Existing codebase uses direct GitHub API calls, keeping implementation consistent avoids adding new dependencies

### Implemented native GitHub App auth instead of Nango integration
- **Chose:** Implemented native GitHub App auth instead of Nango integration
- **Reasoning:** The codebase already had foundation for GitHub App JWT/tokens. Using native implementation avoids external dependency and aligns with existing patterns.

---

## Chapters

### 1. Work
*Agent: default*

- Parser fix already implemented: Parser fix already implemented
- Implemented GitHub App directly instead of using Nango: Implemented GitHub App directly instead of using Nango
- Implemented native GitHub App auth instead of Nango integration: Implemented native GitHub App auth instead of Nango integration
