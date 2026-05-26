# Trajectory: Fix harness runtime review issues

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 25, 2026 at 01:41 PM
> **Completed:** May 25, 2026 at 01:53 PM

---

## Summary

Fixed harness runtime review issues: broker now tracks harness PID separately from worker wrapper PID, validates app-server plans at spawn, extends app-server release grace, avoids app-server delivery_verified overclaiming, and updates SDK/docs examples around env allowlists, permission flags, and attached app-server hosts.

**Approach:** Standard approach

---

## Key Decisions

### Keep app-server plans attach-only for now

- **Chose:** Keep app-server plans attach-only for now
- **Reasoning:** The Rust broker can execute durable JSON plans and report an attached host PID, but broker-owned app-server supervision would need explicit lifecycle ownership; rejecting broker-owned host plans avoids a half-supported mode.

---

## Chapters

### 1. Work

_Agent: default_

- Keep app-server plans attach-only for now: Keep app-server plans attach-only for now
