# Trajectory: Fix required Daytona provider sandbox identity contract for Relay issue #1732

> **Status:** ✅ Completed
> **Task:** relay#1732
> **Confidence:** 90%
> **Started:** September 10, 2026 at 12:14 PM
> **Completed:** September 10, 2026 at 12:16 PM

---

## Summary

Required validated Daytona provider sandbox IDs in Cloud results and covered Fleet output.

**Approach:** Standard approach

---

## Key Decisions

### Require Daytona provider UUID in normalized Cloud responses
- **Chose:** Require Daytona provider UUID in normalized Cloud responses
- **Reasoning:** The stable Cloud sbx identity cannot be inspected or deleted by Daytona tooling; accepting a missing or malformed provider UUID makes ID-bound snapshot attestation and recovery impossible.

---

## Chapters

### 1. Work
*Agent: default*

- Require Daytona provider UUID in normalized Cloud responses: Require Daytona provider UUID in normalized Cloud responses

---

## Artifacts

**Commits:** 87358176f
**Files changed:** 4
