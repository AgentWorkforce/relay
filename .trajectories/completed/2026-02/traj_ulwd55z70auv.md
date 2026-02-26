# Trajectory: Replace daemon terminology and logic with broker across CLI/dashboard

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 23, 2026 at 09:14 AM
> **Completed:** February 23, 2026 at 09:24 AM

---

## Summary

Replaced daemon terminology with broker across CLI, config/utils, and dashboard; switched to broker-first cloud endpoints with compatibility fallbacks and validated via tests/typecheck.

**Approach:** Standard approach

---

## Key Decisions

### Adopt broker-first cloud endpoints with daemon fallback

- **Chose:** Adopt broker-first cloud endpoints with daemon fallback
- **Reasoning:** Cloud/server versions may still expose /api/daemons, so use /api/brokers first and transparently fall back on 404 to avoid breakage during rollout.

---

## Chapters

### 1. Work

_Agent: default_

- Adopt broker-first cloud endpoints with daemon fallback: Adopt broker-first cloud endpoints with daemon fallback
