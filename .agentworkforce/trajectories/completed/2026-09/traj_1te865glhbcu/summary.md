# Trajectory: Compose PR 1632 dispatcher deadlines

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 99%
> **Started:** September 1, 2026 at 09:06 PM
> **Completed:** September 1, 2026 at 09:07 PM

---

## Summary

Raised the dispatcher envelope to 100 minutes and added a contract proving broker wait plus Cloud execution plus five minutes of setup headroom fits within it.

**Approach:** Standard approach

---

## Key Decisions

### Give the dispatcher an explicit composed deadline
- **Chose:** Give the dispatcher an explicit composed deadline
- **Reasoning:** The outer GitHub job must contain the 30-minute broker resolution bound, 60-minute Cloud client bound, and setup/reporting headroom. Raise it to 100 minutes and enforce the numeric relationship in a source-contract test so future child-timeout changes cannot silently exceed the envelope.

---

## Chapters

### 1. Work
*Agent: default*

- Give the dispatcher an explicit composed deadline: Give the dispatcher an explicit composed deadline
