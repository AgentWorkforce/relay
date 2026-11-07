# Trajectory: Finish relay#1543 ordered fleet delivery acknowledgements

> **Status:** ✅ Completed
> **Task:** relay#1543
> **Confidence:** 92%
> **Started:** August 18, 2026 at 10:20 AM
> **Completed:** August 18, 2026 at 10:41 AM

---

## Summary

Finished relay#1543 review fixes: centralized per-agent ACK-floor reduction, advanced surviving floors after cumulative confirmation, avoided full payload clones during cursor restore, added full BrokerRuntime fleet-channel MUST-FIRE/MUST-NOT-FIRE coverage, exercised real dead-letter restart behavior, and split the changelog impact. Full broker test suite and scoped clippy validation pass.

**Approach:** Standard approach

---

## Key Decisions

### Advance surviving per-agent ACK floors only after a real cumulative ACK advances
- **Chose:** Advance surviving per-agent ACK floors only after a real cumulative ACK advances
- **Reasoning:** A confirmed lower sequence is no longer required after commit_confirmed_delivery returns an advanced up_to_seq, so surviving higher pending entries must persist up_to_seq + 1. Terminal failure returns no cumulative ACK and therefore must not raise the floor; this preserves the dead-letter safety boundary.

---

## Chapters

### 1. Work
*Agent: default*

- Advance surviving per-agent ACK floors only after a real cumulative ACK advances: Advance surviving per-agent ACK floors only after a real cumulative ACK advances
- The ordered hold/release path now passes the full broker suite. Review-thread coverage is split cleanly: helper-level terminal ownership tests remain, while the review-targeted test name now drives late confirmations through BrokerRuntime and asserts the fleet channel stays empty; the happy-path test uses the same runtime/channel boundary.
