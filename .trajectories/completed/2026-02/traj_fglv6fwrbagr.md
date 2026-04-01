# Trajectory: Analyze and TDD-split src/cli/index.ts command modules

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** February 20, 2026 at 08:52 AM
> **Completed:** February 20, 2026 at 08:57 AM

---

## Summary

Analyzed 5.3k-line CLI monolith, mapped legacy spawnPty vs AgentRelayClient usage, and delivered tests-first proof-of-concept extraction via new agent-management command module with passing vitest coverage.

**Approach:** Standard approach

---

## Key Decisions

### Start refactor with agent-management command group
- **Chose:** Start refactor with agent-management command group
- **Reasoning:** This group has clear command boundaries and already uses AgentRelayClient, making it the lowest-risk proof of concept for tests-first modularization.

### Use dependency-injected command registration for extracted CLI modules
- **Chose:** Use dependency-injected command registration for extracted CLI modules
- **Reasoning:** Injecting process, logging, and client creation allows deterministic unit tests without process.exit side effects or live broker dependencies.

---

## Chapters

### 1. Work
*Agent: default*

- Start refactor with agent-management command group: Start refactor with agent-management command group
- Use dependency-injected command registration for extracted CLI modules: Use dependency-injected command registration for extracted CLI modules
