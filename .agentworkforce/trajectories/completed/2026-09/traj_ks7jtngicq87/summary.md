# Trajectory: Fix relay#1837 manual_flush ACK gap recovery

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1837
> **Confidence:** 90%
> **Started:** September 22, 2026 at 01:38 AM
> **Completed:** September 22, 2026 at 02:09 AM

---

## Summary

Fixed relay#1837 manual_flush sequence-gap recovery with lossless exact replay, duplicate-injection fencing, deterministic gap diagnostics, and regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Recover only exact unACKed replays whose local custody vanished, preserve fleet delivery IDs through the PTY, and re-ACK completed IDs from a bounded worker cache
- **Chose:** Recover only exact unACKed replays whose local custody vanished, preserve fleet delivery IDs through the PTY, and re-ACK completed IDs from a bounded worker cache
- **Reasoning:** Skipping the cursor would violate cumulative-ACK safety; blindly replaying could duplicate user-visible instructions. Custody-aware replay plus stable end-to-end identity repairs the gap while the worker completion cache makes lost-ACK retries idempotent.

---

## Chapters

### 1. Work
*Agent: default*

- Recover only exact unACKed replays whose local custody vanished, preserve fleet delivery IDs through the PTY, and re-ACK completed IDs from a bounded worker cache: Recover only exact unACKed replays whose local custody vanished, preserve fleet delivery IDs through the PTY, and re-ACK completed IDs from a bounded worker cache
- Implemented custody-aware replay recovery, stable fleet delivery IDs, a bounded PTY completion fence, ordered predecessor reinsertion, and explicit gap diagnostics. Full broker and client-focused suites pass after isolating injected git-hook environment.
