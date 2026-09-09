# Trajectory: Fix standalone Cloud workflow runtime blockers

> **Status:** ✅ Completed
> **Task:** standalone-workflow-fix3-luna-0909
> **Confidence:** 88%
> **Started:** September 9, 2026 at 10:57 PM
> **Completed:** September 9, 2026 at 10:58 PM

---

## Summary

Hardened standalone Bun Cloud workflow execution, daemon restart re-entry, and detached monitor error handling with focused tests and compiled smoke coverage.

**Approach:** Standard approach

---

## Key Decisions

### Use the standalone binary's bundled @relayflows/core runner when Cloud archives have no node_modules
- **Chose:** Use the standalone binary's bundled @relayflows/core runner when Cloud archives have no node_modules
- **Reasoning:** Compiled Bun cannot expose its virtual package files to a Node child, while the bundled core can execute archive-only deterministic and agent workflows.

### Omit Bun's virtual argv[1] during compiled daemon re-entry
- **Chose:** Omit Bun's virtual argv[1] during compiled daemon re-entry
- **Reasoning:** The compiled binary already supplies its virtual entrypoint and parses the first user argument as the command.

---

## Chapters

### 1. Work
*Agent: default*

- Use the standalone binary's bundled @relayflows/core runner when Cloud archives have no node_modules: Use the standalone binary's bundled @relayflows/core runner when Cloud archives have no node_modules
- Omit Bun's virtual argv[1] during compiled daemon re-entry: Omit Bun's virtual argv[1] during compiled daemon re-entry
- All three fresh-review blockers are covered by focused unit tests and real compiled-Bun smoke paths; remaining risk is limited to relayflows runtime behavior beyond the deterministic smoke workflow.

---

## Artifacts

**Commits:** 87eb6c0e4
**Files changed:** 12
