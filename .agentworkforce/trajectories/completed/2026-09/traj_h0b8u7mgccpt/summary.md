# Trajectory: Preserve broker self-spawn with tamper-evident execution

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 91%
> **Started:** September 1, 2026 at 09:56 PM
> **Completed:** September 1, 2026 at 10:08 PM

---

## Summary

Replaced the memfd broker execution bridge with a stable exact-SHA broker path protected by fail-closed Landlock mutation rules, isolated writable roots, capability checks, post-run integrity verification, regression coverage, and reviewer documentation.

**Approach:** Standard approach

---

## Key Decisions

### Use a stable private broker path protected by inherited Landlock mutation denial
- **Chose:** Use a stable private broker path protected by inherited Landlock mutation denial
- **Reasoning:** The prior anonymous memfd preserved verified bytes but broke Rust current_exe self-spawn. A dedicated 0500 path plus Landlock ABI>=3 denies write, truncate, unlink, rename, replacement, and hard-link attacks while preserving current_exe. The trusted parent closes the verification fd before launch, exposes only sibling writable roots, refuses SYS_PTRACE/SYS_ADMIN, and rechecks link count, mode, size, and SHA-256 after execution.

---

## Chapters

### 1. Work
*Agent: default*

- Use a stable private broker path protected by inherited Landlock mutation denial: Use a stable private broker path protected by inherited Landlock mutation denial
- Landlock bridge now passes stable self-spawn and mutation-attack coverage on Linux; local focused/full suites, typecheck, actionlint, formatting, syntax, and diff checks are green.
