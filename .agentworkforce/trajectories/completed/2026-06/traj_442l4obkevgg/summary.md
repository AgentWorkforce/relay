# Trajectory: Extract integration prompt contract package

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** June 17, 2026 at 10:34 PM
> **Completed:** June 17, 2026 at 10:52 PM

---

## Summary

Added @agent-relay/integration-prompts with discovery reader, prompt builders, eval re-exports, tests, and build wiring.

**Approach:** Standard approach

---

## Key Decisions

### Kept integration prompt descriptor portable with optional pear richness
- **Chose:** Kept integration prompt descriptor portable with optional pear richness
- **Reasoning:** Factory only needs provider, mountRoot, and writableResources while Pear needs optional scope, subscription, and history fields to preserve full integrations-update wording.

---

## Chapters

### 1. Work
*Agent: default*

- Kept integration prompt descriptor portable with optional pear richness: Kept integration prompt descriptor portable with optional pear richness
