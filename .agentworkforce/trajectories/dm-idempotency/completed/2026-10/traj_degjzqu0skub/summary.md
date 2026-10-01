# Trajectory: Forward MCP DM idempotency across process boundaries

> **Status:** ✅ Completed
> **Task:** 1874
> **Confidence:** 90%
> **Started:** October 1, 2026 at 08:40 PM
> **Completed:** October 1, 2026 at 08:41 PM

---

## Summary

Forwarded explicit MCP DM keys through raw and session-stamped SDK clients. Protocol/startup 67 tests, SDK 180 tests, six type tests, typecheck and lint pass. Base proof creates two keyed rows; patched proof returns one row and identical receipts; unkeyed sends stay distinct. Two unrelated suite failures reproduce on base, and supplied plan files fail formatting. No live recipient injection check.

**Approach:** Standard approach

---

## Key Decisions

### Forward only explicit DM keys, matching relaycast-client.ts; keep unkeyed sends distinct
- **Chose:** Forward only explicit DM keys, matching relaycast-client.ts; keep unkeyed sends distinct
- **Reasoning:** Re-land the focused production fix from PR 1866. Rebuild the proof with separate processes and a real SDK HTTP path; derive outcomes from observations instead of the arm.

---

## Chapters

### 1. Work
*Agent: default*

- Forward only explicit DM keys, matching relaycast-client.ts; keep unkeyed sends distinct: Forward only explicit DM keys, matching relaycast-client.ts; keep unkeyed sends distinct
