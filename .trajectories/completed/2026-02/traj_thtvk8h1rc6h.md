# Trajectory: Fix broker UUID-suffix registration in Relaycast

> **Status:** ✅ Completed
> **Task:** task-17
> **Confidence:** 92%
> **Started:** February 24, 2026 at 03:05 PM
> **Completed:** February 24, 2026 at 03:10 PM

---

## Summary

Enforced strict broker names and added cached-token reuse for broker init and strict-name 409 conflicts; validated with cargo test and cargo build.

**Approach:** Standard approach

---

## Key Decisions

### Prefer cached relaycast token for strict broker identity
- **Chose:** Prefer cached relaycast token for strict broker identity
- **Reasoning:** Avoids unnecessary re-registration and prevents UUID-suffixed agent_name when name conflict occurs.

---

## Chapters

### 1. Work
*Agent: default*

- Prefer cached relaycast token for strict broker identity: Prefer cached relaycast token for strict broker identity
