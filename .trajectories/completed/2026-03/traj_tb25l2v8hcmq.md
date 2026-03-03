# Trajectory: Evaluate using ACP instead of broker PTY injection

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 3, 2026 at 09:47 AM
> **Completed:** March 3, 2026 at 09:48 AM

---

## Summary

Assessed ACP vs PTY injection: recommend hybrid runtime. Keep PTY for CLI compatibility; add AgentRuntime::Acp for ACP-native agents and route deliveries via ACP session/prompt.

**Approach:** Standard approach

---

## Key Decisions

### ACP is feasible as a new runtime but not a drop-in replacement for PTY injection
- **Chose:** ACP is feasible as a new runtime but not a drop-in replacement for PTY injection
- **Reasoning:** ACP is client↔agent JSON-RPC and can carry prompts/responses, but current broker relies on raw terminal stdin injection semantics for existing CLI workers; ACP terminal methods are command-exec oriented, so existing PTY path must remain for non-ACP CLIs.

---

## Chapters

### 1. Work
*Agent: default*

- ACP is feasible as a new runtime but not a drop-in replacement for PTY injection: ACP is feasible as a new runtime but not a drop-in replacement for PTY injection
