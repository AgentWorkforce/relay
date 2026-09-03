# Trajectory: Fix broker Cloud registration/name mismatch for multiple local brokers

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 3, 2026 at 01:44 PM
> **Completed:** September 3, 2026 at 01:48 PM

---

## Summary

Made node status verify its advertised name and ID against the Cloud addressability endpoint, distinguish confirmed local-only and unknown states, print enrollment/SSH recovery guidance, retry transient 5xx responses within a hard timeout, and add regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Reconcile node status against the Cloud name endpoint instead of treating websocket connectivity as registration
- **Chose:** Reconcile node status against the Cloud name endpoint instead of treating websocket connectivity as registration
- **Reasoning:** Live inspection showed the second broker eventually appears in Cloud, so multiple brokers are supported; the failure window is local readiness advertising a name before the Cloud REST lookup used by --node can resolve it. Status now reports registered, confirmed LOCAL-ONLY, or unknown and gives SSH/state-dir guidance.

---

## Chapters

### 1. Work
*Agent: default*

- Reconcile node status against the Cloud name endpoint instead of treating websocket connectivity as registration: Reconcile node status against the Cloud name endpoint instead of treating websocket connectivity as registration
- Implementation and unit/full suites are green; live status now confirms chief-sfm-final by exact name and node ID after bounded retries through transient Cloud 503s.
