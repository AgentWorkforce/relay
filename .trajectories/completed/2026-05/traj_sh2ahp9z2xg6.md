# Trajectory: Fix uuid install deprecation warning

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 19, 2026 at 01:21 PM
> **Completed:** May 19, 2026 at 01:21 PM

---

## Summary

Removed uuid and @types/uuid from package metadata, switched the benchmark baseline to crypto.randomUUID, bumped OpenClaw dockerode to 5.0.0, and regenerated the npm lockfile so npm install no longer warns about uuid@10.

**Approach:** Standard approach

---

## Key Decisions

### Remove uuid from install path

- **Chose:** Remove uuid from install path
- **Reasoning:** The only direct uuid use was a benchmark baseline, so Node crypto.randomUUID covers it without a shipped dependency; dockerode 5 removes the remaining transitive uuid@10 source.

---

## Chapters

### 1. Work

_Agent: default_

- Remove uuid from install path: Remove uuid from install path
