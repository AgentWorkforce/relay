# Trajectory: Fix view attach teardown signal when target disappears

> **Status:** ✅ Completed
> **Task:** relay#1548
> **Confidence:** 96%
> **Started:** August 17, 2026 at 11:41 AM
> **Completed:** August 17, 2026 at 12:07 PM

---

## Summary

Fixed fleet view attach teardown on released targets, added paired must-fire/must-not-fire coverage and mutation proofs, reproduced the defect live against a Daytona target, and validated broker plus CLI surfaces.

**Approach:** Traced the shared terminal adapter and release paths, established resume semantics, centralized terminal-session finalization at successful worker release, reused it for local HTTP release, and tested both broker lifecycle output and client-visible WebSocket close behavior.

---

## Key Decisions

### Fix the fleet action-release lifecycle rather than adding a view-client-only close
- **Chose:** Fix the fleet action-release lifecycle rather than adding a view-client-only close
- **Reasoning:** Drive and view already share terminal.closed -> WS 1011 handling. Fleet action release is the only examined worker-disappearance path that omits dependent terminal-session finalization; transient terminal-lane disconnect retains its existing resume path.

---

## Chapters

### 1. Work
*Agent: default*

- Fix the fleet action-release lifecycle rather than adding a view-client-only close: Fix the fleet action-release lifecycle rather than adding a view-client-only close
- The asymmetry is release-lifecycle-specific: fleet release omitted terminal finalization, while drive only surfaced closure after input failure. The fix now centralizes worker terminal cleanup, preserves transient transport resume, and paired lifecycle plus loopback tests prove target close and healthy-idle non-close. Both deliberate mutations failed at the intended assertions, and the live pre-fix run reproduced silence versus drive 1011.
