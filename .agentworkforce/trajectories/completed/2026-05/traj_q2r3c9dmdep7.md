# Trajectory: Rename harness plans to harness configs

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** May 25, 2026 at 02:00 PM
> **Completed:** May 25, 2026 at 02:06 PM

---

## Summary

Renamed harness runtime terminology from plan to config across SDK, broker protocol, API payloads, tests, docs, and changelog. The broker now accepts harnessConfig as the primary field while retaining harnessPlan/harness_plan deserialization aliases for compatibility.

**Approach:** Standard approach

---

## Key Decisions

### Rename harness plan API to harness config

- **Chose:** Rename harness plan API to harness config
- **Reasoning:** The adapter output is declarative runtime configuration, not an execution plan; SDK and docs should expose harnessConfig/ResolvedHarnessConfig while the broker keeps legacy harnessPlan aliases for payload tolerance.

---

## Chapters

### 1. Work

_Agent: default_

- Rename harness plan API to harness config: Rename harness plan API to harness config
