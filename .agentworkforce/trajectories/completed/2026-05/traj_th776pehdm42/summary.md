# Trajectory: Keep ACP bridge adapter in core simplification PR

> **Status:** ✅ Completed
> **Confidence:** 84%
> **Started:** May 28, 2026 at 03:54 PM
> **Completed:** May 28, 2026 at 04:02 PM

---

## Summary

Kept @agent-relay/acp-bridge in the simplification PR, restored its workspace package and lockfile entries, and updated it to use SDK messaging/actions instead of removed spawn-first SDK APIs.

**Approach:** Standard approach

---

## Key Decisions

### Retain ACP bridge as an adapter package

- **Chose:** Retain ACP bridge as an adapter package
- **Reasoning:** ACP is still a useful editor integration. It should not be part of the core SDK, but it can stay in the repo if it uses SDK messaging/actions instead of the removed spawn-first SDK facade.

---

## Chapters

### 1. Work

_Agent: default_

- Retain ACP bridge as an adapter package: Retain ACP bridge as an adapter package
