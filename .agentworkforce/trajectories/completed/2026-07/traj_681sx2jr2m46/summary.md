# Trajectory: Refine AI SDK adoption plan for official packages, Node 22, and expanded harness support

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** July 15, 2026 at 07:11 PM
> **Completed:** July 15, 2026 at 07:19 PM

---

## Summary

Refined the AI SDK adoption plan to avoid the fork, require Node 22, host the public low-level HarnessV1 contract, add Pi and experimental Deep Agents, use AI SDK as the promoted headless default, and retain PTY for interactive and unsupported harnesses with pre-start-only fallback.

**Approach:** Standard approach

---

## Key Decisions

### Use official AI SDK HarnessV1 adapters directly, upgrade Relay to Node 22, and retain PTY as the interactive/unsupported pre-start fallback

- **Chose:** Use official AI SDK HarnessV1 adapters directly, upgrade Relay to Node 22, and retain PTY as the interactive/unsupported pre-start fallback
- **Reasoning:** HarnessV1.doPromptTurn already returns prompt control with submitUserMessage across Claude Code, Codex, OpenCode, Pi, and Deep Agents, so Relay can preserve active injection without a fork. Node 22 aligns with official package engines. A data-driven registry expands coverage while avoiding unsafe fallback after work begins.

---

## Chapters

### 1. Work

_Agent: default_

- Use official AI SDK HarnessV1 adapters directly, upgrade Relay to Node 22, and retain PTY as the interactive/unsupported pre-start fallback: Use official AI SDK HarnessV1 adapters directly, upgrade Relay to Node 22, and retain PTY as the interactive/unsupported pre-start fallback
