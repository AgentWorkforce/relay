# Trajectory: Fix Relay SDK broker stdout drain

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 10, 2026 at 10:24 PM
> **Completed:** May 10, 2026 at 10:35 PM

---

## Summary

Fixed Relay SDK broker stdout drain at the source. TypeScript AgentRelayClient.spawn now resumes and drains broker stdout after startup URL parsing; Python SDK spawn now starts a stdout drain task and cancels it during shutdown. Added a TypeScript regression that floods fake broker stdout after startup and a Python unit test for stdout draining. Verified SDK typecheck/build, focused Vitest, and focused pytest suites.

**Approach:** Standard approach

---

## Key Decisions

### Drain spawned broker stdout in SDK clients
- **Chose:** Drain spawned broker stdout in SDK clients
- **Reasoning:** agent-relay run and direct SDK users both reach AgentRelayClient.spawn; after startup URL parsing stdout was left paused/undrained, so the root fix belongs in the TypeScript and Python SDK clients rather than only in Ricky's loader workaround.

---

## Chapters

### 1. Work
*Agent: default*

- Drain spawned broker stdout in SDK clients: Drain spawned broker stdout in SDK clients
