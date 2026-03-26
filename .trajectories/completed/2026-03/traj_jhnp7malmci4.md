# Trajectory: Fix workflow runner E2BIG spawn and verification token double-count

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** March 26, 2026 at 08:53 PM
> **Completed:** March 26, 2026 at 09:11 PM

---

## Summary

Spilled oversized interactive workflow prompts to temp files before PTY spawn and excluded echoed prompt text from output_contains verification, with SDK runner regression tests.

**Approach:** Standard approach

---

## Key Decisions

### Use temp-file task handoff in workflow runner interactive spawns and verify output against post-injection content only
- **Chose:** Use temp-file task handoff in workflow runner interactive spawns and verify output against post-injection content only
- **Reasoning:** Large injected tasks exceed argv limits and raw PTY output includes echoed task text, which can create false positives for output_contains.

---

## Chapters

### 1. Work
*Agent: default*

- Use temp-file task handoff in workflow runner interactive spawns and verify output against post-injection content only: Use temp-file task handoff in workflow runner interactive spawns and verify output against post-injection content only
- Runner now distinguishes the actual PTY prompt from the logical workflow task, which addresses both oversized prompt handoff and token verification on echoed task text.
