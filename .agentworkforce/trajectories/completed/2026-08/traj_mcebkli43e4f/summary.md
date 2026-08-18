# Trajectory: Address PR 1573 review feedback

> **Status:** ✅ Completed
> **Task:** PR-1573
> **Confidence:** 96%
> **Started:** August 18, 2026 at 10:23 PM
> **Completed:** August 18, 2026 at 10:28 PM

---

## Summary

Addressed PR 1573 review feedback with preserved structured control-plane diagnostics, end-to-end loopback request deadlines, more robust reconnect timing tests, and concise release notes.

**Approach:** Standard approach

---

## Key Decisions

### Propagate fleet readiness budget through broker connection metadata
- **Chose:** Propagate fleet readiness budget through broker connection metadata
- **Reasoning:** Snapshot, resize, and delivery-mode calls use HarnessDriverClient over the loopback proxy; without a per-connection request timeout they retain the 30-second default and abort before the proxy's bounded reconnect recovery can finish.

### Retain the bounded post-ready delivery acknowledgement
- **Chose:** Retain the bounded post-ready delivery acknowledgement
- **Reasoning:** The 10-second delivery-mode timer starts only after terminal.ready and bounds one non-replayable remote command; it is not a readiness timer. The loopback client deadline instead covers the full 151.5-second readiness path, the existing 10-second acknowledgement, and a 1-second response margin.

---

## Chapters

### 1. Work
*Agent: default*

- Propagate fleet readiness budget through broker connection metadata: Propagate fleet readiness budget through broker connection metadata
- Retain the bounded post-ready delivery acknowledgement: Retain the bounded post-ready delivery acknowledgement
- Validated the PR findings against the implementation. Preserved structured retry causes at aggregate-budget exhaustion, propagated a 162.5-second loopback HTTP deadline through every attach mode, expanded timing margins, trimmed the changelog, and passed 313 focused tests plus CLI typechecking.
