# Trajectory: Implement Relay issue #1711 Daytona cleanup tombstone semantics

> **Status:** ✅ Completed
> **Task:** relay#1711
> **Confidence:** 93%
> **Started:** September 9, 2026 at 06:02 AM
> **Completed:** September 9, 2026 at 06:07 AM

---

## Summary

Tightened Daytona deletion acceptance to require desiredState=destroyed with state destroying/destroyed; added contradictory-state baseline fixtures. Focused/full verifier gates, matrix validation/dry-run, CLI build, lint, diff, and TruffleHog evidence recorded.

**Approach:** Standard approach

---

## Key Decisions

### Require Daytona desiredState=destroyed alongside destroying/destroyed state
- **Chose:** Require Daytona desiredState=destroyed alongside destroying/destroyed state
- **Reasoning:** Ignoring any provider record with destroying state alone can conceal an active sandbox whose desired state remains running; baseline and cleanup proof must fail closed.

---

## Chapters

### 1. Work
*Agent: default*

- Require Daytona desiredState=destroyed alongside destroying/destroyed state: Require Daytona desiredState=destroyed alongside destroying/destroyed state
- Issue #1711 cleanup contract is now locally covered by accepted tombstone, contradictory active-state, baseline, bounded convergence, failed-delete, and unauthorized fixtures. Focused and full verifier gates are green; monorepo build retains an unrelated missing @ai-sdk/harness-pi blocker.

---

## Artifacts

**Commits:** bc0dbf751
**Files changed:** 2
