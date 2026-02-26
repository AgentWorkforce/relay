# Trajectory: Fix spawned worker Relaycast identity registration mismatch

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 23, 2026 at 01:40 PM
> **Completed:** February 23, 2026 at 01:47 PM

---

## Summary

Removed broker-side worker pre-registration to prevent Relaycast name conflicts; enforced strict worker MCP agent naming; rebuilt broker binary and validated all Rust tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Remove broker-side worker pre-registration in Relaycast

- **Chose:** Remove broker-side worker pre-registration in Relaycast
- **Reasoning:** Pre-claiming names via /v1/agents/spawn races with worker MCP registration and can force suffix identities; worker session should own its Relaycast identity.

---

## Chapters

### 1. Work

_Agent: default_

- Remove broker-side worker pre-registration in Relaycast: Remove broker-side worker pre-registration in Relaycast
