# Trajectory: Analyze openclaw separation of concerns and propose SDK bridge API

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** March 5, 2026 at 08:26 AM
> **Completed:** March 5, 2026 at 08:29 AM

---

## Summary

Delivered separation-of-concerns analysis for openclaw package: current strengths, missing SDK primitives, proposed @relaycast/openclaw API, and required breaking changes for package split

**Approach:** Standard approach

---

## Key Decisions

### Treat openclaw package as overloaded; keep @relaycast/openclaw limited to config/env/bridge/types and move orchestration to @agent-relay/openclaw
- **Chose:** Treat openclaw package as overloaded; keep @relaycast/openclaw limited to config/env/bridge/types and move orchestration to @agent-relay/openclaw
- **Reasoning:** Current index exports include setup/runtime/spawn/MCP/identity/auth concerns and dependency on @agent-relay/sdk, which violates SDK-bridge boundary

---

## Chapters

### 1. Work
*Agent: default*

- Treat openclaw package as overloaded; keep @relaycast/openclaw limited to config/env/bridge/types and move orchestration to @agent-relay/openclaw: Treat openclaw package as overloaded; keep @relaycast/openclaw limited to config/env/bridge/types and move orchestration to @agent-relay/openclaw
