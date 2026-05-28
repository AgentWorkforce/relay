# Trajectory: Workspace-first Agent Relay setup

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 28, 2026 at 04:43 PM
> **Completed:** May 28, 2026 at 04:43 PM

---

## Summary

Added workspace-first SDK/MCP/OpenClaw setup with RELAY_WORKSPACE_KEY as the preferred credential name, retained legacy API-key aliases, and validated SDK, CLI, runtime, harnesses, and OpenClaw builds/tests.

**Approach:** Standard approach

---

## Key Decisions

### Prefer workspace keys over Agent Relay API keys
- **Chose:** Prefer workspace keys over Agent Relay API keys
- **Reasoning:** Workspace creation should be the default onboarding path; RELAY_WORKSPACE_KEY and workspaceKey are now first-class while RELAY_API_KEY/apiKey remain compatibility aliases for existing tools.

---

## Chapters

### 1. Work
*Agent: default*

- Prefer workspace keys over Agent Relay API keys: Prefer workspace keys over Agent Relay API keys
