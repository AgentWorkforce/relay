# Trajectory: Fix generic invoked root timeout inference

> **Status:** ✅ Completed
> **Task:** cloud#3463
> **Confidence:** 95%
> **Started:** September 9, 2026 at 04:16 AM
> **Completed:** September 9, 2026 at 04:17 AM

---

## Summary

Excluded generic invoked timeout roots; TypeScript and Python now infer only direct workflow chains or proven builder variables. Full Node 22 Cloud/CLI tests and builds pass.

**Approach:** Standard approach

---

## Key Decisions

### Require invoked timeout roots to be exactly workflow, while retaining proven assigned builder variables
- **Chose:** Require invoked timeout roots to be exactly workflow, while retaining proven assigned builder variables
- **Reasoning:** Generic factory calls such as httpClient() and Python http_client() can expose timeout methods but are not RelayFlow builders; accepting them would reintroduce false launch metadata.

---

## Chapters

### 1. Work
*Agent: default*

- Require invoked timeout roots to be exactly workflow, while retaining proven assigned builder variables: Require invoked timeout roots to be exactly workflow, while retaining proven assigned builder variables
- Generic invoked roots are now excluded in both TypeScript and Python; full Cloud and CLI suites, builds, format, and diff checks are passing.
