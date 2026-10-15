# Trajectory: Warn when fleet release leaves Cloud sandboxes running

> **Status:** ✅ Completed
> **Task:** 1922
> **Confidence:** 90%
> **Started:** October 16, 2026 at 01:19 AM
> **Completed:** October 16, 2026 at 01:26 AM

---

## Summary

Added the dispatched-release sandbox cost warning without changing JSON stdout or requesting provider teardown. Added seven regressions, one RelayFlow bugfix proof, and a patch changelog entry. Independent review found no actionable issues. Full Windows suite limitations are documented for maintainer validation.

**Approach:** Standard approach

---

## Key Decisions

### Warn once after a dispatched release acknowledgement, before optional identity cleanup
- **Chose:** Warn once after a dispatched release acknowledgement, before optional identity cleanup
- **Reasoning:** The release endpoint acknowledges worker dispatch only. Emitting through the existing stderr warning sink preserves the single JSON stdout document and covers delete-agent variants without invoking Cloud/provider deletion.

---

## Chapters

### 1. Work
*Agent: default*

- Warn once after a dispatched release acknowledgement, before optional identity cleanup: Warn once after a dispatched release acknowledgement, before optional identity cleanup
- The seven new regressions and all 18 release tests pass. Both proof observations match the expected bug/fixed behavior. Typecheck and formatting pass; full Windows validation has 342 failures and a worker OOM, and the fleet Unix-path mismatch is confirmed on unchanged main.
