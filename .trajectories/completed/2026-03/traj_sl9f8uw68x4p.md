# Trajectory: Fix /openclaw root path by adding explicit redirect

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** March 4, 2026 at 02:37 PM
> **Completed:** March 4, 2026 at 02:37 PM

---

## Summary

Fixed /openclaw route by adding OpenClawRootRedirect function (308 to /openclaw/) and moving static mount to /openclaw/; preserves invite-token query redirect compatibility to /openclaw/invite/<token>.

**Approach:** Standard approach

---

## Key Decisions

### Add dedicated /openclaw redirect handler and mount static site at /openclaw/

- **Chose:** Add dedicated /openclaw redirect handler and mount static site at /openclaw/
- **Reasoning:** Eliminates ambiguous root-path behavior and ensures naked /openclaw resolves reliably to cached static content

---

## Chapters

### 1. Work

_Agent: default_

- Add dedicated /openclaw redirect handler and mount static site at /openclaw/: Add dedicated /openclaw redirect handler and mount static site at /openclaw/
