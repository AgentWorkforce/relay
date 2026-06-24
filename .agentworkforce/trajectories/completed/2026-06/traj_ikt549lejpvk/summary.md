# Trajectory: Debug invalid API key for integration webhook create-inbound

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** June 24, 2026 at 03:34 PM
> **Completed:** June 24, 2026 at 03:38 PM

---

## Summary

Fixed inbound webhook CLI local workflow auth fallback. The new create-inbound/list-inbound/delete-inbound commands now retry once with the running project broker's workspace key after SDK Invalid API key or missing-key failures, preserving explicit --workspace-key behavior. Added focused tests and changelog entry; CLI package build passes.

**Approach:** Standard approach

---

## Key Decisions

### Retry inbound webhook CLI operations with local broker workspace key after SDK auth failure

- **Chose:** Retry inbound webhook CLI operations with local broker workspace key after SDK auth failure
- **Reasoning:** PR 1193 added command wrappers, but local workflows can still use stale global SDK auth; retrying only inbound webhook commands preserves explicit --workspace-key behavior while making local broker sessions work.

---

## Chapters

### 1. Work

_Agent: default_

- Retry inbound webhook CLI operations with local broker workspace key after SDK auth failure: Retry inbound webhook CLI operations with local broker workspace key after SDK auth failure
- Focused CLI tests and package build pass; change is scoped to inbound webhook auth fallback
