# Trajectory: SDK simplification and dashboard migration to SDK

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 23, 2026 at 01:21 AM
> **Completed:** January 23, 2026 at 01:22 AM

---

## Summary

Added createRelay/createPair for dead-simple communication, added MCP createTools for programmatic use, migrated dashboard from wrapper to SDK with full test coverage

**Approach:** Standard approach

---

## Key Decisions

### Lazy-load daemon in SDK standalone
- **Chose:** Lazy-load daemon in SDK standalone
- **Reasoning:** Keeps SDK lightweight for client-only users

### Migrate dashboard to SDK instead of wrapper
- **Chose:** Migrate dashboard to SDK instead of wrapper
- **Reasoning:** Consolidate to single RelayClient implementation

### Use TDD for migration
- **Chose:** Use TDD for migration
- **Reasoning:** Created compatibility tests before changing imports

---

## Chapters

### 1. Work
*Agent: default*

- Lazy-load daemon in SDK standalone: Lazy-load daemon in SDK standalone
- Migrate dashboard to SDK instead of wrapper: Migrate dashboard to SDK instead of wrapper
- Use TDD for migration: Use TDD for migration
