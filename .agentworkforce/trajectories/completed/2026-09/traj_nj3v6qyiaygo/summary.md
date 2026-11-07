# Trajectory: Add compiled red-green RelayFlow proof for registration timeout

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** September 1, 2026 at 07:49 PM
> **Completed:** September 1, 2026 at 07:49 PM

---

## Summary

Added a RelayFlow bugfix case that builds the exact base and head broker binaries, demonstrates the base timing out against a healthy 12-second registration response, and demonstrates the head accepting the same response. Both arms passed locally; manifest, syntax, formatting, and all 45 proof-contract tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Drive the compiled broker against a 12-second local Relaycast response
- **Chose:** Drive the compiled broker against a 12-second local Relaycast response
- **Reasoning:** The base binary must exhibit its real 10-second timeout and the head binary must accept the same healthy response. This avoids source-text assertions and removes external Relaycast latency from the feature gate.

---

## Chapters

### 1. Work
*Agent: default*

- Drive the compiled broker against a 12-second local Relaycast response: Drive the compiled broker against a 12-second local Relaycast response
