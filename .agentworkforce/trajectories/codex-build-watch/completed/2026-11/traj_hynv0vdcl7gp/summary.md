# Trajectory: Avoid rebuilding native core when Git index changes

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** November 4, 2026 at 08:29 AM
> **Completed:** November 4, 2026 at 08:32 AM

---

## Summary

Removed unused Git index watch; HEAD/ref metadata preserved. Actual build-script regression passes for staging, branch commits, detached commits and explicit releases. Controlled index-only release rebuild fell from 78.693s to 0.317s (272 artifacts fresh). Local benchmark only; clean CI recompilation and version metadata remain separate work.

**Approach:** Standard approach

---

## Key Decisions

### Watch only Git inputs that affect embedded revision
- **Chose:** Watch only Git inputs that affect embedded revision
- **Reasoning:** Cargo fingerprint logs show touching only the builder Git index recompiles both public and private core (65.813 seconds versus 0.441 seconds unchanged). HEAD and its active ref remain watched because revision metadata depends on commits; the index never affects build output.

---

## Chapters

### 1. Initial work
*Agent: codex-relay-desktop-speed-up*

- Watch only Git inputs that affect embedded revision: Watch only Git inputs that affect embedded revision
