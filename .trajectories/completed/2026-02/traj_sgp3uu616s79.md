# Trajectory: Gate initial PTY task injection until Codex is ready after MCP boot

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 27, 2026 at 09:31 PM
> **Completed:** February 27, 2026 at 09:35 PM

---

## Summary

Confirmed premature worker_ready flow and implemented PTY startup gating so worker_ready emits only after Codex relaycast MCP boot returns to prompt (with timeout fallback). Added tests for boot gating and prompt detection.

**Approach:** Standard approach

---

## Key Decisions

### Gate PTY worker_ready on startup readiness for Codex with relaycast MCP
- **Chose:** Gate PTY worker_ready on startup readiness for Codex with relaycast MCP
- **Reasoning:** worker_ready previously fired on init_worker before Codex completed MCP boot, causing broker to inject initial_task too early. Gate now requires post-boot prompt detection (or timeout fallback) before emitting worker_ready.

---

## Chapters

### 1. Work
*Agent: default*

- Gate PTY worker_ready on startup readiness for Codex with relaycast MCP: Gate PTY worker_ready on startup readiness for Codex with relaycast MCP

---

## Artifacts

**Commits:** 6aa7883a
