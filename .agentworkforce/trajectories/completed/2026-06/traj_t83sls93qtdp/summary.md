# Trajectory: Fix GitHub issue 1169

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** June 19, 2026 at 01:30 PM
> **Completed:** June 19, 2026 at 01:34 PM

---

## Summary

Fixed fleet serve node-definition loading for Bun-compiled CLI by using native import for JavaScript node files, lazy-loading jiti only for TypeScript sources, and validating the fleet marker locally to avoid compiled runtime import failures.

**Approach:** Standard approach

---

## Key Decisions

### Use native dynamic import for JS fleet node definitions
- **Chose:** Use native dynamic import for JS fleet node definitions
- **Reasoning:** The Bun-compiled CLI fails when jiti constructs its transform backend; compiled JS can be loaded by the runtime directly, so jiti should only be loaded for TypeScript-like sources that need transpilation.

### Validate loaded fleet node definitions locally in the CLI
- **Chose:** Validate loaded fleet node definitions locally in the CLI
- **Reasoning:** The Bun-compiled smoke showed the fleet SDK validator import can be undefined in the standalone binary; the public validator only checks the __agentRelayFleetNode marker, so a local marker check avoids another runtime import failure without changing validation behavior.

---

## Chapters

### 1. Work
*Agent: default*

- Use native dynamic import for JS fleet node definitions: Use native dynamic import for JS fleet node definitions
- Validate loaded fleet node definitions locally in the CLI: Validate loaded fleet node definitions locally in the CLI
