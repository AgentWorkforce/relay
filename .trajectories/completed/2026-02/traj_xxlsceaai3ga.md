# Trajectory: Migrate ACP bridge from @agent-relay/sdk to @agent-relay/broker-sdk

> **Status:** ✅ Completed
> **Confidence:** 79%
> **Started:** February 18, 2026 at 10:03 AM
> **Completed:** February 18, 2026 at 10:07 AM

---

## Summary

Migrated ACP bridge relay path from RelayClient (@agent-relay/sdk) to AgentRelay (@agent-relay/broker-sdk) in acp-agent.ts, updated dependency, and validated with TypeScript checks.

**Approach:** Standard approach

---

## Key Decisions

### Use AgentRelay.human().sendMessage with per-target try/catch and sentCount

- **Chose:** Use AgentRelay.human().sendMessage with per-target try/catch and sentCount
- **Reasoning:** broker-sdk sendMessage is async/throws and no longer returns a boolean; this preserves old fail-if-none-sent behavior for @mentions and broadcasts

### Implement release via listAgents() + agent.release()

- **Chose:** Implement release via listAgents() + agent.release()
- **Reasoning:** AgentRelay facade exposes release on Agent handles; resolving by name from listAgents keeps command semantics while using public broker-sdk APIs

---

## Chapters

### 1. Work

_Agent: default_

- Use AgentRelay.human().sendMessage with per-target try/catch and sentCount: Use AgentRelay.human().sendMessage with per-target try/catch and sentCount
- Implement release via listAgents() + agent.release(): Implement release via listAgents() + agent.release()
