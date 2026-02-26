# Trajectory: Comprehensive broker reliability fixes: pre-registration, delivery finalization, log sanitization

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** February 23, 2026 at 02:28 PM
> **Completed:** February 23, 2026 at 02:46 PM

---

## Summary

Implemented robust broker fixes: pre-registration with canonical Relaycast CLI, strict worker identity env, pending-delivery finalization on delivery_injected with stale-event guard, and normalized worker log chunk persistence.

**Approach:** Standard approach

---

## Key Decisions

### Clear pending deliveries on delivery_injected (with event_id guard)

- **Chose:** Clear pending deliveries on delivery_injected (with event_id guard)
- **Reasoning:** Prevents duplicate message re-injection while still rejecting stale lifecycle events with mismatched event_id.

### Pre-register workers with Relaycast using normalized CLI hints

- **Chose:** Pre-register workers with Relaycast using normalized CLI hints
- **Reasoning:** Relaycast spawn/register now enforces allowed CLI values; broker must send canonical cli (claude/codex/gemini/aider/goose) to avoid 400 failures.

---

## Chapters

### 1. Work

_Agent: default_

- Clear pending deliveries on delivery_injected (with event_id guard): Clear pending deliveries on delivery_injected (with event_id guard)
- Pre-register workers with Relaycast using normalized CLI hints: Pre-register workers with Relaycast using normalized CLI hints
