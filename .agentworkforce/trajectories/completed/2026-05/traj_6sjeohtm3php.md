# Trajectory: Address broker headless reliability review findings

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 15, 2026 at 11:30 AM
> **Completed:** May 15, 2026 at 11:32 AM

---

## Summary

Addressed review findings: status --wait-for now waits for broker HTTP API readiness instead of PID-only readiness, added a regression test for live PID with 503 startup API, verified TypeScript and focused CLI tests, and prepared trajectory records for commit with index.json.

**Approach:** Standard approach

---

## Key Decisions

### Require broker API readiness for status --wait-for

- **Chose:** Require broker API readiness for status --wait-for
- **Reasoning:** connection.json is written before Relaycast handshake and ready router setup, so PID-only polling can report RUNNING before spawn/control endpoints are usable.

---

## Chapters

### 1. Work

_Agent: default_

- Require broker API readiness for status --wait-for: Require broker API readiness for status --wait-for
