# Trajectory: Strengthen relay #1602 adopted-worker regression

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1602 review
> **Confidence:** 96%
> **Started:** August 25, 2026 at 09:49 AM
> **Completed:** August 25, 2026 at 09:49 AM

---

## Summary

Reworked issue 1602 coverage so an adopted live PTY is reconciled with its immutable identity and remains in inventory.sync and heartbeat across reconnect.

**Approach:** Standard approach

---

## Key Decisions

### Test the repaired union, not equality of incomplete projections
- **Chose:** Test the repaired union, not equality of incomplete projections
- **Reasoning:** Incident evidence established the heartbeat-only PTY was live; the regression must first prove identity-safe reconciliation adds it to inventory, then prove heartbeat and reconnect retain that repaired set.

---

## Chapters

### 1. Work
*Agent: default*

- Test the repaired union, not equality of incomplete projections: Test the repaired union, not equality of incomplete projections
