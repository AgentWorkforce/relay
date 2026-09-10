# Trajectory: Fix standalone Bun Agent Relay workflow execution

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** September 9, 2026 at 09:18 PM
> **Completed:** September 9, 2026 at 09:36 PM

---

## Summary

Added shared compiled-Bun workflow runtime selection, Node-based project-relative relayflows resolution, local monitor and Cloud worker fixes, focused tests, and CI standalone workflow smoke.

**Approach:** Standard approach

---

## Key Decisions

### Use a shared compiled-Bun workflow runtime helper
- **Chose:** Use a shared compiled-Bun workflow runtime helper
- **Reasoning:** Compiled Bun process.execPath is the standalone binary; local workflow, detached monitor, and Cloud assignment children need a real Node executable and project-relative relayflows resolution.

### Resolve relayflows with Node execFile from the real workflow directory in compiled mode
- **Chose:** Resolve relayflows with Node execFile from the real workflow directory in compiled mode
- **Reasoning:** Bun's createRequire remains tied to the sealed compiled image, so project dependency resolution must run through Node with argv arrays.

---

## Chapters

### 1. Work
*Agent: default*

- Use a shared compiled-Bun workflow runtime helper: Use a shared compiled-Bun workflow runtime helper
- Resolve relayflows with Node execFile from the real workflow directory in compiled mode: Resolve relayflows with Node execFile from the real workflow directory in compiled mode
- The shared helper now covers command selection, dependency resolution, missing-runtime diagnostics, local monitor supervision, Cloud assignment execution, and a real compiled-Bun smoke.

---

## Artifacts

**Commits:** df9cd939b
**Files changed:** 11
