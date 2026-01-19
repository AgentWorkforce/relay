# Trajectory: Investigate spawn timing issue where messages sent with spawn don't arrive

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 18, 2026 at 10:46 PM
> **Completed:** January 18, 2026 at 10:47 PM

---

## Summary

Found root cause: race condition between spawner registration check (connected-agents.json), isAgentOnline (agents.json with 30s threshold), and router.has(to) registry check. Task messages fail when sent before agent is in the registry.

**Approach:** Standard approach

---

## Key Decisions

### Identified root cause of spawn timing issue
- **Chose:** Identified root cause of spawn timing issue
- **Reasoning:** The issue is a race condition between 3 different systems checking for agent 'online' status, combined with the spawning agent not having access to the registry until after the task message is sent.

---

## Chapters

### 1. Work
*Agent: default*

- Identified root cause of spawn timing issue: Identified root cause of spawn timing issue
