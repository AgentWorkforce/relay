# Trajectory: Make PR 1631 RelayFlow proof self-bootstrapping

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** September 1, 2026 at 07:56 PM
> **Completed:** September 1, 2026 at 07:56 PM

---

## Summary

Made the compiled registration-timeout RelayFlow case install the official minimal Rust toolchain when Cargo is absent; syntax, formatting, proof-contract tests, and the local exact-head binary observation pass.

**Approach:** Standard approach

---

## Key Decisions

### Install the official minimal Rust toolchain only when Cargo is absent
- **Chose:** Install the official minimal Rust toolchain only when Cargo is absent
- **Reasoning:** The Daytona proof image lacks Cargo, while the case must execute the exact compiled base and head binaries. Reusing Cargo when present keeps local and cached runs fast; official rustup provides the missing compiler inside the disposable proof sandbox.

---

## Chapters

### 1. Work
*Agent: default*

- Install the official minimal Rust toolchain only when Cargo is absent: Install the official minimal Rust toolchain only when Cargo is absent
