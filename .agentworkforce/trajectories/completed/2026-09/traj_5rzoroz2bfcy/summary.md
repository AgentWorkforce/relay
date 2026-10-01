# Trajectory: Address Devin feedback: consumer install of CLI 13 vs @relayflows/sdk peers

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** September 30, 2026 at 04:54 PM
> **Completed:** September 30, 2026 at 04:55 PM

---

## Summary

Addressed Devin feedback: pin published CLI to peer-safe @relayflows/sdk@2.0.22 and add next-major consumer install proof. Kept monorepo publish override as defense in depth.

**Approach:** Standard approach

---

## Key Decisions

### Pin published CLI to @relayflows/sdk@2.0.22 and keep monorepo override
- **Chose:** Pin published CLI to @relayflows/sdk@2.0.22 and keep monorepo override
- **Reasoning:** Devin correctly noted the root override does not travel with agent-relay. No @relayflows/sdk release yet accepts SDK 13 peers (flows push denied), so pin the last peer-free release (2.0.22) and prove next-major consumer install in vitest.

---

## Chapters

### 1. Work
*Agent: default*

- Pin published CLI to @relayflows/sdk@2.0.22 and keep monorepo override: Pin published CLI to @relayflows/sdk@2.0.22 and keep monorepo override

---

## Artifacts

**Commits:** 67fd39736
**Files changed:** 7
