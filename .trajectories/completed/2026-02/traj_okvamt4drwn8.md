# Trajectory: Strict hard cut: remove daemon fallbacks/aliases and enforce broker-only warnings

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 23, 2026 at 09:34 AM
> **Completed:** February 23, 2026 at 09:34 AM

---

## Summary

Removed daemon fallbacks/aliases, enforced broker-only APIs, and added loud breaking warnings in CLI/dashboard

**Approach:** Standard approach

---

## Key Decisions

### Removed daemon compatibility layer entirely across CLI/dashboard; broker endpoints and fields are now required
- **Chose:** Removed daemon compatibility layer entirely across CLI/dashboard; broker endpoints and fields are now required
- **Reasoning:** Prevent silent mixed-mode failures and force explicit migration to broker-only APIs

---

## Chapters

### 1. Work
*Agent: default*

- Removed daemon compatibility layer entirely across CLI/dashboard; broker endpoints and fields are now required: Removed daemon compatibility layer entirely across CLI/dashboard; broker endpoints and fields are now required
