# Trajectory: Address PR #1253 review: ANSI grammar, resize owner lifecycle, watchdog reset

> **Status:** ✅ Completed
> **Task:** 1247
> **Confidence:** 85%
> **Started:** July 13, 2026 at 01:10 AM
> **Completed:** July 13, 2026 at 01:31 AM

---

## Summary

Addressed PR #1253 review: ANSI grammar (double-ESC restart, ESC intermediates, OSC/STR ESC handling, strip_ansi CSI final-byte + DCS alignment), resize owner lifecycle (empty session-id normalization, real release outcomes, serde-default dims + release-without-size, same-size owner-refresh no-op + periodic client re-assert, teardown-path cleanup, detach-race await), and watchdog reset on confirmed drainer write

**Approach:** Standard approach

---

## Key Decisions

### Cluster B1 client re-assert via unref'd interval, broker same-size no-op
- **Chose:** Cluster B1 client re-assert via unref'd interval, broker same-size no-op
- **Reasoning:** No timer DI existed; unref'd setInterval cleared on teardown keeps ownership alive without SIGWINCH; simplest robust option per review

### Cluster C: reset no_pid counter in drainer on confirmed write, share AtomicU32 via Arc
- **Chose:** Cluster C: reset no_pid counter in drainer on confirmed write, share AtomicU32 via Arc
- **Reasoning:** Enqueue success proved only queue room, not delivery; confirmed flush is real child-side activity

---

## Chapters

### 1. Work
*Agent: default*

- Cluster B1 client re-assert via unref'd interval, broker same-size no-op: Cluster B1 client re-assert via unref'd interval, broker same-size no-op
- Cluster C: reset no_pid counter in drainer on confirmed write, share AtomicU32 via Arc: Cluster C: reset no_pid counter in drainer on confirmed write, share AtomicU32 via Arc
