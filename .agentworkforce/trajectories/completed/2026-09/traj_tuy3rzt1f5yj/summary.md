# Trajectory: Harden PR #1631 proof toolchain resolution

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1631
> **Confidence:** 90%
> **Started:** September 1, 2026 at 08:28 PM
> **Completed:** September 1, 2026 at 08:29 PM

---

## Summary

Made the compiled RelayFlow runner preserve installed rustup toolchain state while failing clearly when Cargo is absent.

**Approach:** Standard approach

---

## Key Decisions

### Derive rustup state from the resolved Cargo executable
- **Chose:** Derive rustup state from the resolved Cargo executable
- **Reasoning:** The proof harness sanitizes HOME; when Cargo is a rustup proxy under an existing .cargo/bin path, passing matching CARGO_HOME and RUSTUP_HOME lets the installed toolchain work without downloading or trusting mutable installer code.

---

## Chapters

### 1. Work
*Agent: default*

- Derive rustup state from the resolved Cargo executable: Derive rustup state from the resolved Cargo executable
