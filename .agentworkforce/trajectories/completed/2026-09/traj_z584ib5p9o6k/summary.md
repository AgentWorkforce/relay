# Trajectory: Close pty-worker echo-before-ack review feedback for PR 1634

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1634
> **Confidence:** 95%
> **Started:** September 2, 2026 at 03:38 AM
> **Completed:** September 2, 2026 at 03:40 AM

---

## Summary

Closed the final PR 1634 worker echo-before-ack race with immediate buffered verification and full regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Check the worker echo buffer immediately after the compound-write acknowledgement
- **Chose:** Check the worker echo buffer immediately after the compound-write acknowledgement
- **Reasoning:** Claude can echo the multiline body during the 250 ms submit delay, before the acknowledgement arm installs verification; consuming that buffered echo prevents a false five-second timeout without changing delivery ordering.

---

## Chapters

### 1. Work
*Agent: default*

- Check the worker echo buffer immediately after the compound-write acknowledgement.
- Final review identified the same echo-before-ack timing window in worker mode; the focused regression and full broker suite now pass with immediate buffered-echo confirmation.

---

## Artifacts

**Commit:** 25377b316
**File changed:** `crates/broker/src/pty_worker.rs`
