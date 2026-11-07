# Trajectory: Fix restored fleet delivery acknowledgement ordering

> **Status:** ✅ Completed
> **Task:** relay#1543
> **Confidence:** 92%
> **Started:** August 17, 2026 at 10:56 PM
> **Completed:** August 17, 2026 at 11:38 PM

---

## Summary

Implemented restart-safe per-agent ordering for echo-confirmed fleet delivery acknowledgements, including a durable ACK floor and explicit out-of-order, in-order, and second-restart regression coverage.

**Approach:** Stored worker-confirmed sequences in each fleet cursor, restored pending siblings in sequence order, retained higher confirmations until the lower contiguous prefix lands, persisted the first required sequence across snapshots, and verified the broker suite plus formatting and lint checks.

---

## Key Decisions

### Restore pending fleet cursors from sequenced siblings and hold confirmed gaps per agent
- **Chose:** Restore pending fleet cursors from sequenced siblings and hold confirmed gaps per agent
- **Reasoning:** Pre-seeding alone drops the higher delivery's eventual ack. The delivery book now retains out-of-order confirmations, while the pending entry remains persisted and maintenance excludes only actively held confirmations; the contiguous prefix releases as one cumulative ack.

---

## Chapters

### 1. Work
*Agent: default*

- Restore pending fleet cursors from sequenced siblings and hold confirmed gaps per agent: Restore pending fleet cursors from sequenced siblings and hold confirmed gaps per agent
- The initial in-memory per-agent hold/release closes the immediate out-of-order acknowledgement, but a higher confirmed entry can outlive the lower entry and another restart. Persisting each agent's first still-required sequence alongside every withheld ACK preserves the gap across that second restart; replaying pending siblings in explicit sequence order then releases only a contiguous confirmed prefix.

---

## Artifacts

**Commits:** 0098957c4, d570c6ee2, 79a69fd91, 5fd61e9fe, 28337030d, 0e4744407, 9f3b24e44, e3217d290, 58198b1ad, 006fd5108, e369f0e03, 6fb4c2f8c
**Files changed:** 67
