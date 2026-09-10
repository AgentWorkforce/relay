# Trajectory: Consolidate trusted cleanroom proof into PR 1665 single RelayFlow case

> **Status:** ✅ Completed
> **Task:** relay#1665
> **Confidence:** 93%
> **Started:** September 8, 2026 at 09:13 PM
> **Completed:** September 8, 2026 at 09:25 PM

---

## Summary

Consolidated the trusted cleanroom runner security regression into PR 1665's immutable Fleet snapshot RelayFlow and proved exact base absent/head fixed in clean detached checkouts.

**Approach:** Standard approach

---

## Key Decisions

### Keep one declared RelayFlow case and run issue 1682 trust assertions as auxiliary checks inside it
- **Chose:** Keep one declared RelayFlow case and run issue 1682 trust assertions as auxiliary checks inside it
- **Reasoning:** The PR proof dispatcher fails closed when more than one case directory changes; issue 1682 is a security correction to the still-unmerged 1665 feature, so both behaviors must be proven atomically without weakening the one-case contract.

---

## Chapters

### 1. Work
*Agent: default*

- Keep one declared RelayFlow case and run issue 1682 trust assertions as auxiliary checks inside it: Keep one declared RelayFlow case and run issue 1682 trust assertions as auxiliary checks inside it
- PR 1665 now carries both immutable Fleet snapshot and trusted cleanroom security proof in one declared RelayFlow case; exact clean base/head red-green passed.

---

## Artifacts

**Commits:** be9cbeaf8
**Files changed:** 5
