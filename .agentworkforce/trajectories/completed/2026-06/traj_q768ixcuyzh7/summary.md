# Trajectory: Architecture refactor: decompose SDK/CLI god files into single-responsibility modules

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** June 21, 2026 at 02:47 PM
> **Completed:** June 21, 2026 at 03:21 PM

---

## Summary

Decomposed the three largest TypeScript god files behind unchanged public surfaces: sdk relaycast.ts (1654->1126; +translate/placement/client modules), harness-driver client.ts (1199->931; +spawn-request/broker-process), cloud workflows.ts (1129->893; +workflow-paths). Each a verified pure move: build green, 959 tests pass throughout, live smoke tests, and independent autoreview (all APPROVE). Declined merging translate vs normalize record readers due to genuine semantic divergence.

**Approach:** Standard approach

---

## Key Decisions

### Trimmed export keyword off translate.ts module-private record readers (readRecord/readNumber/readBoolean/readStringArray/readMention); deliberately did NOT merge readers with normalize.ts
- **Chose:** Trimmed export keyword off translate.ts module-private record readers (readRecord/readNumber/readBoolean/readStringArray/readMention); deliberately did NOT merge readers with normalize.ts
- **Reasoning:** normalize.ts readers have divergent semantics (readString coerces number/bigint->string, readRecord clones) so consolidating would be a behavior change, not a pure refactor

### Extracted pure workflow-path parsing (YAML + TS literal scanner) from cloud/workflows.ts into workflow-paths.ts
- **Chose:** Extracted pure workflow-path parsing (YAML + TS literal scanner) from cloud/workflows.ts into workflow-paths.ts
- **Reasoning:** workflows.ts mixed pure text parsing with auth/S3/API IO; isolating the side-effect-free parsers makes them testable and shrinks the IO module. Validation (incl child_process) and runtime-only regex kept behind.

---

## Chapters

### 1. Work
*Agent: default*

- Trimmed export keyword off translate.ts module-private record readers (readRecord/readNumber/readBoolean/readStringArray/readMention); deliberately did NOT merge readers with normalize.ts: Trimmed export keyword off translate.ts module-private record readers (readRecord/readNumber/readBoolean/readStringArray/readMention); deliberately did NOT merge readers with normalize.ts
- Extracted pure workflow-path parsing (YAML + TS literal scanner) from cloud/workflows.ts into workflow-paths.ts: Extracted pure workflow-path parsing (YAML + TS literal scanner) from cloud/workflows.ts into workflow-paths.ts

---

## Artifacts

**Commits:** 8e494d2, 3fe8ae1, 08035c2, a61deaf
**Files changed:** 10
