# Trajectory: Fix relaycast handshake budget for slow backend

> **Status:** ✅ Completed
> **Task:** relay#1562
> **Confidence:** 90%
> **Started:** August 18, 2026 at 11:59 AM
> **Completed:** August 18, 2026 at 12:08 PM

---

## Summary

Raised the Relaycast startup handshake default to three 12-second attempts, added an honest unconfirmed-response diagnostic, and added production-latency plus SDK-budget regression coverage. Full broker tests and scoped Clippy pass.

**Approach:** Standard approach

---

## Key Decisions

### Use three 12-second handshake attempts under the SDK deadline
- **Chose:** Use three 12-second handshake attempts under the SDK deadline
- **Reasoning:** Production successes took 7.4-9.5s, so 5s guarantees false timeouts. Three 12s attempts tolerate that slow backend with 2.5s headroom while two backoffs total 750ms, yielding a 36.75s never-response bound inside the harness SDK's verified 45s startupTimeoutMs default. This prioritizes slow-backend survival while retaining two retries; adaptive timing would require observing ambiguous in-flight mutations after timeout.

---

## Chapters

### 1. Work
*Agent: default*

- Use three 12-second handshake attempts under the SDK deadline: Use three 12-second handshake attempts under the SDK deadline
- The original default demonstrably rejected the measured 9.5s success path; the new 12s x 3 budget passes both latency and 45s exhaustion constraints. Full broker tests pass. Strict Clippy is blocked only by an unrelated existing terminal_control while-let lint; the scoped rerun allowing that single baseline lint is clean.
