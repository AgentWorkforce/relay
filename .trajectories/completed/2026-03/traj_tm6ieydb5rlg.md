# Trajectory: Analyze openclaw package split between @agent-relay/openclaw and @relaycast/openclaw

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 5, 2026 at 07:49 AM
> **Completed:** March 5, 2026 at 07:51 AM

---

## Summary

Analyzed @agent-relay/openclaw vs @relaycast/openclaw and produced stay/migrate boundary, required imports, and migration risk assessment.

**Approach:** Standard approach

---

## Key Decisions

### Keep orchestration runtime in @agent-relay/openclaw; move shared OpenClaw config primitives to @relaycast/openclaw
- **Chose:** Keep orchestration runtime in @agent-relay/openclaw; move shared OpenClaw config primitives to @relaycast/openclaw
- **Reasoning:** Matches target architecture: orchestration package owns gateway/spawn/mcp/control; relaycast package owns reusable detection and relaycast env config shared by setup and status flows.

---

## Chapters

### 1. Work
*Agent: default*

- Keep orchestration runtime in @agent-relay/openclaw; move shared OpenClaw config primitives to @relaycast/openclaw: Keep orchestration runtime in @agent-relay/openclaw; move shared OpenClaw config primitives to @relaycast/openclaw
