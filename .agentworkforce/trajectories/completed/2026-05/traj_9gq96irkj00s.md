# Trajectory: Update relay to use published relaycast Rust reclaim fix

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** May 10, 2026 at 08:45 PM
> **Completed:** May 10, 2026 at 08:48 PM

---

## Summary

Bumped relay to relaycast 1.0.1 and routed strict-name agent startup through the SDK-owned register_or_get_agent reclaim path, removing the relay-local raw JSON/urlencoding workaround.

**Approach:** Standard approach

---

## Key Decisions

### Use relaycast 1.0.1 register_or_get_agent for strict-name reclaim

- **Chose:** Use relaycast 1.0.1 register_or_get_agent for strict-name reclaim
- **Reasoning:** The Rust SDK now tolerates the public agent payload and owns the get-agent plus rotate-token flow, so relay no longer needs direct HttpClient JSON parsing or urlencoding.

---

## Chapters

### 1. Work

_Agent: default_

- Use relaycast 1.0.1 register_or_get_agent for strict-name reclaim: Use relaycast 1.0.1 register_or_get_agent for strict-name reclaim
