# Trajectory: Require explicit NightCTO 2xx delivery receipts

> **Status:** ✅ Completed
> **Task:** relay#1642
> **Confidence:** 98%
> **Started:** September 3, 2026 at 02:52 AM
> **Completed:** September 3, 2026 at 02:53 AM

---

## Summary

Required an explicit final 2xx NightCTO response and proved a 302 response fails both executable test layers

**Approach:** Standard approach

---

## Key Decisions

### Require the final HTTP status to be 2xx instead of relying on curl transport success
- **Chose:** Require the final HTTP status to be 2xx instead of relying on curl transport success
- **Reasoning:** curl can return zero for a 3xx response, but a redirect is not evidence that NightCTO accepted the POST.

---

## Chapters

### 1. Work
*Agent: default*

- Require the final HTTP status to be 2xx instead of relying on curl transport success: Require the final HTTP status to be 2xx instead of relying on curl transport success

---

## Artifacts

**Commits:** d5860fa4c
**Files changed:** 3
