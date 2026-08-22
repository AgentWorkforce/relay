# Trajectory: Resolve assigned repositories on fleet nodes before spawn

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 19, 2026 at 09:01 AM
> **Completed:** August 19, 2026 at 10:07 AM

---

## Summary

Implemented node-local repository assignment resolution with private repo map ingestion, key-only registration, fail-closed spawn validation, malicious cwd rejection, and focused Rust/CLI coverage; integrated the wire parent and passed format, typecheck, clippy, and tests.

**Approach:** Standard approach

---

## Key Decisions

### Keep repository paths node-private and resolve only assignment keys at the final spawn boundary
- **Chose:** Keep repository paths node-private and resolve only assignment keys at the final spawn boundary
- **Reasoning:** Factory-provided cwd variants cross a trust boundary; loading and consuming the node-local map at broker startup prevents path disclosure and inheritance, while spawn-time filesystem checks fail closed if checkout state changes.

---

## Chapters

### 1. Work
*Agent: default*

- Keep repository paths node-private and resolve only assignment keys at the final spawn boundary: Keep repository paths node-private and resolve only assignment keys at the final spawn boundary
- Integrated the complete wire parent before finalizing the node lane; the final diff is limited to node-local ingestion, registration key derivation, CLI env bridging, and authoritative spawn resolution.

---

## Artifacts

**Commits:** f57210bd0
**Files changed:** 11
