# Trajectory: Add broker HTTP /api/send for local worker delivery

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 23, 2026 at 11:53 AM
> **Completed:** February 23, 2026 at 12:04 PM

---

## Summary

Registered worker agents in Relaycast on spawn/restart and released them on exit/release so dashboard direct messaging resolves via Relaycast presence

**Approach:** Standard approach

---

## Key Decisions

### Fix worker visibility by broker-managed Relaycast lifecycle
- **Chose:** Fix worker visibility by broker-managed Relaycast lifecycle
- **Reasoning:** Direct messaging resolution is Relaycast-based in dashboard, so workers must be explicit Relaycast agents during their runtime, not inferred from local spawn state.

---

## Chapters

### 1. Work
*Agent: default*

- Fix worker visibility by broker-managed Relaycast lifecycle: Fix worker visibility by broker-managed Relaycast lifecycle
