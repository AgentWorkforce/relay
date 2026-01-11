# Trajectory: Investigate prod cloud cursor error

> **Status:** ✅ Completed
> **Confidence:** 60%
> **Started:** January 10, 2026 at 11:11 PM
> **Completed:** January 10, 2026 at 11:13 PM

---

## Summary

Investigated Codex cursor read timeout; Codex CLI queries cursor position and fails if PTY doesn’t respond—current PtyWrapper handles CSI 6n with ESC[1;1R; advise ensuring prod uses that build or backport.

**Approach:** Standard approach
