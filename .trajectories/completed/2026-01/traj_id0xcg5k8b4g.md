# Trajectory: Fix relay-pty binary not found on global npm install

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 25, 2026 at 12:28 PM
> **Completed:** January 25, 2026 at 12:28 PM

---

## Summary

Fixed relay-pty binary resolution for global npm installs by extracting shared utility. Binary search now handles nested @agent-relay/* packages correctly using non-greedy regex to find root node_modules.

**Approach:** Standard approach

---

## Key Decisions

### Root cause: wrapper's findRelayPtyBinary() wasn't updated with global npm install fixes from spawner.ts
- **Chose:** Root cause: wrapper's findRelayPtyBinary() wasn't updated with global npm install fixes from spawner.ts
- **Reasoning:** The spawner.ts had comprehensive path resolution but wrapper had outdated 3-levels-up calculation that breaks for nested @agent-relay/* packages

### Extract to shared utility instead of duplicating fix
- **Chose:** Extract to shared utility instead of duplicating fix
- **Reasoning:** User requested reuse over duplication. Created @agent-relay/utils/relay-pty-path so both spawner.ts and wrapper use same logic

---

## Chapters

### 1. Work
*Agent: default*

- Root cause: wrapper's findRelayPtyBinary() wasn't updated with global npm install fixes from spawner.ts: Root cause: wrapper's findRelayPtyBinary() wasn't updated with global npm install fixes from spawner.ts
- Extract to shared utility instead of duplicating fix: Extract to shared utility instead of duplicating fix
