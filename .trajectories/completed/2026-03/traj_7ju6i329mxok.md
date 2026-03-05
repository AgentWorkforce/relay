# Trajectory: Analyze @agent-relay/openclaw split to @relaycast/openclaw

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 5, 2026 at 11:52 AM
> **Completed:** March 5, 2026 at 12:14 PM

---

## Summary

Analyzed openclaw package boundary and proposed @relaycast/openclaw ownership, API surface, and breaking changes for SDK/bridge split

**Approach:** Standard approach

---

## Key Decisions

### Use existing BOUNDARY.md as baseline and validate against current source exports
- **Chose:** Use existing BOUNDARY.md as baseline and validate against current source exports
- **Reasoning:** Boundary doc exists but must be checked against real files and sibling @relaycast/openclaw package

### @relaycast/openclaw should own only config detection, .env IO, lightweight delivery bridge, and shared types/constants
- **Chose:** @relaycast/openclaw should own only config detection, .env IO, lightweight delivery bridge, and shared types/constants
- **Reasoning:** Current package exports orchestration/runtime/spawn/MCP concerns that belong in @agent-relay/openclaw; keeping bridge package minimal avoids heavy deps and circular boundaries

---

## Chapters

### 1. Work
*Agent: default*

- Use existing BOUNDARY.md as baseline and validate against current source exports: Use existing BOUNDARY.md as baseline and validate against current source exports
- @relaycast/openclaw should own only config detection, .env IO, lightweight delivery bridge, and shared types/constants: @relaycast/openclaw should own only config detection, .env IO, lightweight delivery bridge, and shared types/constants
