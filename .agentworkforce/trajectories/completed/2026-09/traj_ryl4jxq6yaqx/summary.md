# Trajectory: Resume task from handoff-1825

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** September 20, 2026 at 09:03 PM
> **Completed:** September 20, 2026 at 09:58 PM

---

## Summary

Closed the phase-0 delivery seam cancellation race with provisional in-doubt receipts, terminalized and dead-lettered cursor-covered fleet siblings, strengthened per-delivery observation accounting and mutation proof, repaired migration evidence gates, and validated Rust/typecheck/parity/Veto review.

**Approach:** Standard approach

---

## Key Decisions

### Use provisional in-doubt receipt plus typed terminal timeout for F8
- **Chose:** Use provisional in-doubt receipt plus typed terminal timeout for F8
- **Reasoning:** The outer retry deadline can cancel after writer-queue admission. Recording before await makes cancellation fail closed; marking the pending entry at the retry cap and returning TerminalInDoubt prevents a live retry. This may suppress a provably pre-write delivery if cancellation wins before the backend reports refusal, but it preserves rule 2: never resend on doubt.

### Fail closed at the backend admission boundary and terminalize cursor-covered siblings
- **Chose:** Fail closed at the backend admission boundary and terminalize cursor-covered siblings
- **Reasoning:** A cancelled PTY handoff may already have entered the sole writer queue, so retry safety requires a provisional in-doubt receipt; cursor advances must terminal-guard, emit failure, and dead-letter every removed sibling instead of silently retaining away operator evidence.

### Keep acceptance honest about declared baseline failures
- **Chose:** Keep acceptance honest about declared baseline failures
- **Reasoning:** The workflow already uses regression-gate for three unreachable full-suite failures, so final acceptance must apply the same classifier; full-package Cargo runs must not forbid legitimate zero-test auxiliary targets.

---

## Chapters

### 1. Work
*Agent: default*

- Use provisional in-doubt receipt plus typed terminal timeout for F8: Use provisional in-doubt receipt plus typed terminal timeout for F8
- Fail closed at the backend admission boundary and terminalize cursor-covered siblings: Fail closed at the backend admission boundary and terminalize cursor-covered siblings
- Keep acceptance honest about declared baseline failures: Keep acceptance honest about declared baseline failures
- Phase-0 seam hardening is implemented and independently scanned; all task-specific, Rust, typecheck, mutation, and live parity checks pass. Final workflow acceptance is intentionally blocked only on genuine Claude and Codex signoff artifacts.
