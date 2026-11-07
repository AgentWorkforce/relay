# Trajectory: Add structured spawned-agent results

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** May 20, 2026 at 05:24 PM
> **Completed:** May 20, 2026 at 05:43 PM

---

## Summary

Added structured spawned-agent result contracts across the broker, MCP tool, and TypeScript SDK, with focused Rust and Vitest coverage plus docs.

**Approach:** Standard approach

---

## Key Decisions

### Implemented structured agent results as a broker-mediated callback token plus MCP tool

- **Chose:** Implemented structured agent results as a broker-mediated callback token plus MCP tool
- **Reasoning:** The SDK can declare a result contract at spawn time, the broker mints a per-agent callback token, and the injected Relaycast MCP server exposes submit_result without requiring the spawned agent to know broker credentials.

---

## Chapters

### 1. Work

_Agent: default_

- Implemented structured agent results as a broker-mediated callback token plus MCP tool
