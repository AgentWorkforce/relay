# Trajectory: Simplify high-level spawn facade

> **Status:** ✅ Completed
> **Task:** PR-1003
> **Confidence:** 91%
> **Started:** May 27, 2026 at 10:33 AM
> **Completed:** May 27, 2026 at 10:43 AM

---

## Summary

Simplified the high-level AgentRelay spawn facade to a single overloaded spawnAgent(config) API with runtime-discriminated pty/headless configs; removed shorthand CLI spawners and high-level spawnPty/spawnHeadless/spawn/spawnAndWait surfaces; updated SDK docs, examples, and focused tests.

**Approach:** Standard approach

---

## Key Decisions

### Use AgentRelay.spawnAgent as the only high-level spawn facade

- **Chose:** Use AgentRelay.spawnAgent as the only high-level spawn facade
- **Reasoning:** The user asked to simplify the high-level SDK and avoid separate pty/headless/named CLI entry points. A single overloaded spawnAgent(config) keeps one public spelling while preserving runtime-specific typing through a pty/headless config discriminant.

### Recommend narrowing Agent Relay around communication core

- **Chose:** Recommend narrowing Agent Relay around communication core
- **Reasoning:** The repo's public promise is real-time agent-to-agent communication, but the default CLI and SDK also expose cloud runtime, proactive agents, drive/relayfile, memory/policy/hooks/trajectory, workflow primitives, GitHub/Slack/browser primitives, personas, web/brand, and multiple bridge surfaces. Keep broker, messaging, spawning, MCP, lifecycle, logs, and minimal SDK as core; move higher-level orchestration and integrations behind extension packages or separate workspaces.

---

## Chapters

### 1. Work

_Agent: default_

- Use AgentRelay.spawnAgent as the only high-level spawn facade: Use AgentRelay.spawnAgent as the only high-level spawn facade
- Recommend narrowing Agent Relay around communication core: Recommend narrowing Agent Relay around communication core
