# Trajectory: Fix PR CI command snapshot

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** June 18, 2026 at 05:12 PM
> **Completed:** June 18, 2026 at 05:13 PM

---

## Summary

Fixed PR CI by adding the newly registered fleet workspace CLI commands to the bootstrap expected command list.

**Approach:** Standard approach

---

## Key Decisions

### Updated bootstrap expected CLI commands for fleet workspace controls
- **Chose:** Updated bootstrap expected CLI commands for fleet workspace controls
- **Reasoning:** CI failed because createProgram now registers fleet config/enable/disable/inherit, but the bootstrap test expected list still omitted them.

---

## Chapters

### 1. Work
*Agent: default*

- Updated bootstrap expected CLI commands for fleet workspace controls: Updated bootstrap expected CLI commands for fleet workspace controls
