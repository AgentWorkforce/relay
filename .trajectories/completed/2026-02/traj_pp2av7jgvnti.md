# Trajectory: Fix broker spawn, task injection, message routing & code refactoring

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** February 23, 2026 at 06:16 PM
> **Completed:** February 23, 2026 at 06:17 PM

---

## Summary

Implemented task injection for HTTP API and WS spawns, added pre-registration retry with RegRetryOutcome, extracted listen_api.rs and moved relaycast event types to relaycast_ws.rs, reducing main.rs by ~400 lines

**Approach:** Standard approach

---

## Key Decisions

### Extracted HTTP API handlers into src/listen_api.rs and relaycast event types/registration helpers into src/relaycast_ws.rs

- **Chose:** Extracted HTTP API handlers into src/listen_api.rs and relaycast event types/registration helpers into src/relaycast_ws.rs
- **Reasoning:** main.rs was 5031 lines, reduced to 4633 by extracting self-contained modules. HTTP API and relaycast event parsing were the most cohesive extractable blocks.

### Used retry_agent_registration helper with RegRetryOutcome enum for pre-registration retry

- **Chose:** Used retry_agent_registration helper with RegRetryOutcome enum for pre-registration retry
- **Reasoning:** Shared retry logic between HTTP API and WS spawn paths. Enum approach avoids confusing continue semantics inside for loops in match arms.

---

## Chapters

### 1. Work

_Agent: default_

- Extracted HTTP API handlers into src/listen_api.rs and relaycast event types/registration helpers into src/relaycast_ws.rs: Extracted HTTP API handlers into src/listen_api.rs and relaycast event types/registration helpers into src/relaycast_ws.rs
- Used retry_agent_registration helper with RegRetryOutcome enum for pre-registration retry: Used retry_agent_registration helper with RegRetryOutcome enum for pre-registration retry

---

## Artifacts

**Commits:** b8604a03
**Files changed:** 3
