# Trajectory: P0 model selection hookup

> **Status:** ✅ Completed
> **Task:** agent-relay-510
> **Confidence:** 80%
> **Started:** January 20, 2026 at 06:58 AM
> **Completed:** January 20, 2026 at 08:46 AM

---

## Summary

Mapped agent profile models to CLI variants, wired spawner to use model mapping with cost tracking, and added model defaults to agent profiles

**Approach:** Standard approach

---

## Key Decisions

### Only default to claude:sonnet when request CLI is plain 'claude' and profile lacks model
- **Chose:** Only default to claude:sonnet when request CLI is plain 'claude' and profile lacks model
- **Reasoning:** Avoid overriding explicit CLI variants while still honoring profile defaults

### Changed AckPayload.response from boolean to string for richer response bodies
- **Chose:** Changed AckPayload.response from boolean to string for richer response bodies
- **Reasoning:** Design doc specifies string for response body, enables status codes like OK/ERROR and custom response text

### Changed AckPayload.response from boolean to string for richer response status codes
- **Chose:** Changed AckPayload.response from boolean to string for richer response status codes
- **Reasoning:** Design doc specifies string for response body, enables status codes like OK/ERROR

### Used correlation-based ACK matching for pending request tracking
- **Chose:** Used correlation-based ACK matching for pending request tracking
- **Reasoning:** Daemon tracks correlationId to match ACK responses to original blocking SEND requests

### Added 6 comprehensive daemon tests for ACK correlation and timeout handling
- **Chose:** Added 6 comprehensive daemon tests for ACK correlation and timeout handling
- **Reasoning:** Tests cover duplicate correlationId, missing correlationId, connection cleanup, unmatched ACK, and default timeout behavior

---

## Chapters

### 1. Work
*Agent: default*

- Only default to claude:sonnet when request CLI is plain 'claude' and profile lacks model: Only default to claude:sonnet when request CLI is plain 'claude' and profile lacks model
- Changed AckPayload.response from boolean to string for richer response bodies: Changed AckPayload.response from boolean to string for richer response bodies
- Changed AckPayload.response from boolean to string for richer response status codes: Changed AckPayload.response from boolean to string for richer response status codes
- Used correlation-based ACK matching for pending request tracking: Used correlation-based ACK matching for pending request tracking
- Added 6 comprehensive daemon tests for ACK correlation and timeout handling: Added 6 comprehensive daemon tests for ACK correlation and timeout handling
