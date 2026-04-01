# Trajectory: Analyze opencode serve and add HTTP API integration

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 28, 2026 at 10:51 AM
> **Completed:** January 28, 2026 at 10:51 AM

---

## Summary

Added OpenCode HTTP API integration with OpenCodeWrapper class, OpenCodeApi client, and typed RelayEvent definitions. The wrapper supports HTTP API mode (via opencode serve's /tui/append-prompt) with PTY fallback. Also added typed event definitions inspired by opencode's BusEvent pattern.

**Approach:** Standard approach

---

## Key Decisions

### Chose hybrid HTTP API + PTY fallback approach
- **Chose:** Chose hybrid HTTP API + PTY fallback approach
- **Reasoning:** HTTP API mode provides cleaner integration when opencode serve is running, but PTY fallback ensures compatibility when it's not available. This gives users flexibility without requiring opencode serve to be running.

### Adopted opencode BusEvent pattern for typed events
- **Chose:** Adopted opencode BusEvent pattern for typed events
- **Reasoning:** Zod schema validation provides type-safe events and enables future OpenAPI spec generation for SDK auto-generation.

---

## Chapters

### 1. Work
*Agent: default*

- Chose hybrid HTTP API + PTY fallback approach: Chose hybrid HTTP API + PTY fallback approach
- Adopted opencode BusEvent pattern for typed events: Adopted opencode BusEvent pattern for typed events
