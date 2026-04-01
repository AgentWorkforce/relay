# Trajectory: Fix spawned agent identity confusion

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 23, 2026 at 09:09 AM
> **Completed:** January 23, 2026 at 09:10 AM

---

## Summary

Fixed spawned agent identity confusion by passing real spawner name to task injection, adding AGENT_RELAY_SPAWNER env var, and updating docs

**Approach:** Standard approach

---

## Key Decisions

### Pass spawnerName to injectTask instead of hardcoded 'spawner'
- **Chose:** Pass spawnerName to injectTask instead of hardcoded 'spawner'
- **Reasoning:** Spawned agents were replying to 'spawner' because that's what the FROM field showed

### Add AGENT_RELAY_SPAWNER environment variable
- **Chose:** Add AGENT_RELAY_SPAWNER environment variable
- **Reasoning:** Gives spawned agents programmatic way to identify their lead

### Add 'When You Are Spawned' section to relay protocol docs
- **Chose:** Add 'When You Are Spawned' section to relay protocol docs
- **Reasoning:** Clear onboarding guidance for new agents

---

## Chapters

### 1. Work
*Agent: default*

- Pass spawnerName to injectTask instead of hardcoded 'spawner': Pass spawnerName to injectTask instead of hardcoded 'spawner'
- Add AGENT_RELAY_SPAWNER environment variable: Add AGENT_RELAY_SPAWNER environment variable
- Add 'When You Are Spawned' section to relay protocol docs: Add 'When You Are Spawned' section to relay protocol docs
