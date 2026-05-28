# Trajectory: Align SDK harness session contract with README

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** May 28, 2026 at 02:37 PM
> **Completed:** May 28, 2026 at 02:53 PM

---

## Summary

Aligned the SDK with the README target by adding AgentRelay facade exports, session/harness contracts, Zod-like action schemas, receiveMessage delivery support, rich message attachment types, docs updates, and focused tests.

**Approach:** Standard approach

---

## Key Decisions

### Add an additive session module instead of rewriting DeliveryRunner in place
- **Chose:** Add an additive session module instead of rewriting DeliveryRunner in place
- **Reasoning:** The README target distinguishes harness/session contracts from durable inbox delivery. Keeping DeliveryRunner compatible avoids breaking existing SDK behavior while exposing the new create/receive/release contract.

---

## Chapters

### 1. Work
*Agent: default*

- Add an additive session module instead of rewriting DeliveryRunner in place: Add an additive session module instead of rewriting DeliveryRunner in place
