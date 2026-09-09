# Trajectory: Retry transient Relaycast workspace_busy admission failures

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** September 10, 2026 at 12:33 AM
> **Completed:** September 10, 2026 at 12:42 AM

---

## Summary

Added bounded Relaycast workspace_busy startup/admission retry with diagnostics-preserving exhaustion tests, unrelated-429 terminal coverage, explicit fail-closed session boundary documentation, and a patch changelog entry.

**Approach:** Standard approach

---

## Key Decisions

### Retry only the exact HTTP 429 workspace_busy admission code
- **Chose:** Retry only the exact HTTP 429 workspace_busy admission code
- **Reasoning:** Generic 429s may represent credential or quota policy and must remain terminal; RelayError 8.0.0 does not retain Retry-After, so the existing bounded 200ms/400ms startup backoff is the safest available fallback.

### Keep complete startup handshake fail-closed after admission retry exhaustion
- **Chose:** Keep complete startup handshake fail-closed after admission retry exhaustion
- **Reasoning:** Replaying startup would repeat unkeyed workspace and agent registration POSTs and could create duplicate or orphaned identities.

---

## Chapters

### 1. Work
*Agent: default*

- Retry only the exact HTTP 429 workspace_busy admission code: Retry only the exact HTTP 429 workspace_busy admission code
- Keep complete startup handshake fail-closed after admission retry exhaustion: Keep complete startup handshake fail-closed after admission retry exhaustion
- The broker now retries exact workspace_busy admission failures at the request boundary, while preserving terminal behavior for unrelated 429s and complete-handshake replay safety. Focused, full broker library tests and clippy are green.
