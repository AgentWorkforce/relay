# Trajectory: Revise AgentRelay headless facade naming

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 27, 2026 at 08:32 AM
> **Completed:** May 27, 2026 at 08:36 AM

---

## Summary

Revised the PR API to avoid exposing provider terminology at the AgentRelay facade: removed public AgentRelay.spawnProvider, changed spawnHeadless to accept cli, routed headless property spawners through the same helper, and updated docs/tests/changelog.

**Approach:** Standard approach

---

## Key Decisions

### Use cli-based AgentRelay.spawnHeadless instead of public spawnProvider
- **Chose:** Use cli-based AgentRelay.spawnHeadless instead of public spawnProvider
- **Reasoning:** The high-level facade should present runtime choice as spawnPty versus spawnHeadless. Provider is a lower-level client implementation detail and reads poorly at the recipe layer where callers already resolve a CLI/harness plan.

---

## Chapters

### 1. Work
*Agent: default*

- Use cli-based AgentRelay.spawnHeadless instead of public spawnProvider: Use cli-based AgentRelay.spawnHeadless instead of public spawnProvider
