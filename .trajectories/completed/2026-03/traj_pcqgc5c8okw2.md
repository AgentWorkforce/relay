# Trajectory: Analyze openclaw package split between @agent-relay/openclaw and @relaycast/openclaw

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** March 5, 2026 at 08:19 AM
> **Completed:** March 5, 2026 at 08:23 AM

---

## Summary

Analyzed @agent-relay/openclaw vs @relaycast/openclaw and produced file/function boundary, import changes, and migration risk assessment

**Approach:** Standard approach

---

## Key Decisions

### Keep orchestration runtime (gateway/spawn/mcp/control/setup flow) in @agent-relay/openclaw; migrate config primitives and shared gateway config types into @relaycast/openclaw
- **Chose:** Keep orchestration runtime (gateway/spawn/mcp/control/setup flow) in @agent-relay/openclaw; migrate config primitives and shared gateway config types into @relaycast/openclaw
- **Reasoning:** Removes duplicated detect/config logic while preserving orchestrator-only responsibilities and avoiding circular dependencies

---

## Chapters

### 1. Work
*Agent: default*

- Keep orchestration runtime (gateway/spawn/mcp/control/setup flow) in @agent-relay/openclaw; migrate config primitives and shared gateway config types into @relaycast/openclaw: Keep orchestration runtime (gateway/spawn/mcp/control/setup flow) in @agent-relay/openclaw; migrate config primitives and shared gateway config types into @relaycast/openclaw
