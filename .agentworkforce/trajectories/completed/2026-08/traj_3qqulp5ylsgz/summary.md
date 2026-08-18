# Trajectory: Align standalone smoke deadline with broker handshake budget

> **Status:** ✅ Completed
> **Task:** PR-1573
> **Confidence:** 97%
> **Started:** August 18, 2026 at 10:10 PM
> **Completed:** August 18, 2026 at 10:18 PM

---

## Summary

Aligned the standalone package smoke supervisor with the broker handshake contract by raising its default deadline from 30 to 60 seconds and adding a regression test that enforces at least ten seconds of headroom over the broker aggregate timeout.

**Approach:** Standard approach

---

## Key Decisions

### Set standalone smoke default to 60 seconds and test it against the broker aggregate
- **Chose:** Set standalone smoke default to 60 seconds and test it against the broker aggregate
- **Reasoning:** The broker explicitly owns a 40-second aggregate handshake plus post-announcement setup reserve; a 30-second supervisor kills a valid retry in flight and masks the specific broker error. Sixty seconds leaves deterministic headroom while still bounding the job.

---

## Chapters

### 1. Work
*Agent: default*

- Set standalone smoke default to 60 seconds and test it against the broker aggregate: Set standalone smoke default to 60 seconds and test it against the broker aggregate
- GitHub macOS package validation failed at the smoke wrapper's 30-second deadline while the broker's third handshake attempt was still valid under its 40-second aggregate budget. Raised the wrapper default to 60 seconds, added a source-coupling regression test, reproduced the slow path with a deterministic 36-second exact-binary smoke, passed 49 focused tests and type/lint/syntax/diff gates, and received sequential fresh Claude and Codex signoff.
