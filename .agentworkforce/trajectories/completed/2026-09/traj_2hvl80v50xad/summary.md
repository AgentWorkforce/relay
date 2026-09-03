# Trajectory: Implement Relayflow v1-v2 public selection

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 2, 2026 at 08:13 PM
> **Completed:** September 2, 2026 at 08:25 PM

---

## Summary

Repaired PR 1640 so omitted Relayflow selectors remain absent, explicit v1 and v2 reach run and nested schedule requests, and forged values fail before authentication, filesystem, network, or CLI client invocation. Added byte-level request and argv regression coverage while preserving resume selectors and existing proof fixtures.

**Approach:** Standard approach

---

## Key Decisions

### Validate relayflowVersion at the Cloud client boundary before authentication
- **Chose:** Validate relayflowVersion at the Cloud client boundary before authentication
- **Reasoning:** The public TypeScript union protects typed callers, while runtime validation makes JavaScript/forged values fail before auth refresh, filesystem reads, prepare calls, uploads, or launch requests; omission remains absent rather than being defaulted client-side.

### Serialize the selector only on explicit run and nested schedule requests
- **Chose:** Serialize the selector only on explicit run and nested schedule requests
- **Reasoning:** Cloud owns the v1 default and schedule update merge semantics. Sending no field preserves legacy bytes and lets resume generation remain authoritative server-side; explicit v1/v2 are forwarded without inference from file type or workflow source.

### Advanced existing PR 1640 instead of opening a duplicate
- **Chose:** Advanced existing PR 1640 instead of opening a duplicate
- **Reasoning:** Lead identified exact reviewed head b9cef439; repairs are additive on that lineage and no schedule-update endpoint exists to extend.

---

## Chapters

### 1. Work
*Agent: default*

- Validate relayflowVersion at the Cloud client boundary before authentication: Validate relayflowVersion at the Cloud client boundary before authentication
- Serialize the selector only on explicit run and nested schedule requests: Serialize the selector only on explicit run and nested schedule requests
- Advanced existing PR 1640 instead of opening a duplicate: Advanced existing PR 1640 instead of opening a duplicate
- Literal evidence: RED cloud selector contract: Test Files 1 failed (1), Tests 7 failed | 1 passed | 30 skipped (38); RED CLI argv: Test Files 1 failed (1), Tests 6 failed | 1 passed | 65 skipped (72). GREEN final focused: Test Files 2 passed (2), Tests 113 passed (113). TYPECHECK PASS: session config cloud utils policy sdk harness-driver harnesses fleet cli. FULL Node 22: Test Files 1 failed | 148 passed | 2 skipped (151), Tests 1 failed | 2301 passed | 22 skipped (2324); sole failure is unrelated process-timeout proof descendantPid 0, also reproduced independently before PR-head repairs, so gate code was not edited.

---

## Artifacts

**Commits:** 81ecd9aa, ee11aa45, 0bcef67f, 7a735b23, 7e30bb6e, bf4b9181
**Files changed:** 9
