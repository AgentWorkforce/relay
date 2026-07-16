# Trajectory: Plan Relay adoption of Vercel AI SDK agent spawning

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** July 15, 2026 at 04:50 PM
> **Completed:** July 15, 2026 at 04:58 PM

---

## Summary

Assessed Relay spawn and delivery layers against the adjacent Vercel AI SDK fork and produced a staged hybrid adoption plan covering the minimal session-steering fork patch, a local-host sandbox provider, Relay AgentSession compatibility, provider pilots, contract tests, shadow soak gates, fallback, Node version isolation, and fork distribution.

**Approach:** Standard approach

---

## Key Decisions

### Use a hybrid AI SDK adoption: AI SDK owns supported headless runtime adapters; Relay retains broker, durable delivery, PTY, placement, and unsupported CLIs
- **Chose:** Use a hybrid AI SDK adoption: AI SDK owns supported headless runtime adapters; Relay retains broker, durable delivery, PTY, placement, and unsupported CLIs
- **Reasoning:** The AI SDK fork already provides mature Claude Code, Codex, and OpenCode lifecycle/bridge adapters and in-flight user-message controls, while Relay has stronger broker delivery, PTY, remote placement, and provider coverage. A staged opt-in adapter minimizes fork surface and preserves fallback.

---

## Chapters

### 1. Work
*Agent: default*

- Use a hybrid AI SDK adoption: AI SDK owns supported headless runtime adapters; Relay retains broker, durable delivery, PTY, placement, and unsupported CLIs: Use a hybrid AI SDK adoption: AI SDK owns supported headless runtime adapters; Relay retains broker, durable delivery, PTY, placement, and unsupported CLIs
