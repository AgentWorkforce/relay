# Trajectory: Improve duplicate broker startup error reporting

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 23, 2026 at 08:58 AM
> **Completed:** February 23, 2026 at 08:58 AM

---

## Summary

Added actionable duplicate-broker startup errors with remediation, plus tests and live verification

**Approach:** Standard approach

---

## Key Decisions

### Classify duplicate-broker startup errors and print remediation
- **Chose:** Classify duplicate-broker startup errors and print remediation
- **Reasoning:** Users should see actionable guidance (status/down/force) instead of a raw process exit code when lock conflicts happen

---

## Chapters

### 1. Work
*Agent: default*

- Classify duplicate-broker startup errors and print remediation: Classify duplicate-broker startup errors and print remediation
