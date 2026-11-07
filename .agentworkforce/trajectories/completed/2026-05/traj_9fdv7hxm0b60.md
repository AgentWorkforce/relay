# Trajectory: Strict standalone smoke follow-up

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 15, 2026 at 12:37 PM
> **Completed:** May 15, 2026 at 12:43 PM

---

## Summary

Fixed the remaining standalone macOS smoke failure by detecting Bun compiled binary argv shape, omitting the virtual //root entrypoint during detached re-exec, and aligning detached startup success output with the smoke readiness contract.

**Approach:** Standard approach

---

## Key Decisions

### Treat Bun //root argv as a virtual executable entrypoint

- **Chose:** Treat Bun //root argv as a virtual executable entrypoint
- **Reasoning:** CI showed compiled standalone still timed out; Bun compiled binaries report argv[1] as a virtual //root path while execPath is the real binary, so detached re-exec must preserve user args from argv[2] but omit the virtual path when spawning the child.

### Align headless success output with standalone smoke readiness contract

- **Chose:** Align headless success output with standalone smoke readiness contract
- **Reasoning:** The fixed Bun re-exec path started the broker locally, but the CI smoke contract asserts exactly one 'Broker started.' readiness line. The detached path now emits that stable line and logs the PID separately.

---

## Chapters

### 1. Work

_Agent: default_

- Treat Bun //root argv as a virtual executable entrypoint: Treat Bun //root argv as a virtual executable entrypoint
- Align headless success output with standalone smoke readiness contract: Align headless success output with standalone smoke readiness contract
