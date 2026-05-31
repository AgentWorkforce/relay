# Trajectory: Review and fix PR #1018

> **Status:** ✅ Completed
> **Confidence:** 78%
> **Started:** May 31, 2026 at 04:56 PM
> **Completed:** May 31, 2026 at 04:59 PM

---

## Summary

Reviewed PR #1018, fixed PTY relay-agent env inheritance for skip_relay_prompt launcher mode, added focused unit coverage and changelog entry.

**Approach:** Standard approach

---

## Key Decisions

### Explicitly remove inherited PTY relay-agent env before applying child contract

- **Chose:** Explicitly remove inherited PTY relay-agent env before applying child contract
- **Reasoning:** Tokio Command inherits the broker process environment by default, so skip_relay_prompt could still leak RELAY_AGENT_TOKEN, RELAY_AGENT_TYPE, or RELAY_STRICT_AGENT_NAME unless the keys are removed.

---

## Chapters

### 1. Work

_Agent: default_

- Explicitly remove inherited PTY relay-agent env before applying child contract: Explicitly remove inherited PTY relay-agent env before applying child contract
