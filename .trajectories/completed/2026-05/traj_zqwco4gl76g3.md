# Trajectory: Fix issue 878

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 19, 2026 at 12:18 AM
> **Completed:** May 19, 2026 at 12:27 AM

---

## Summary

Narrowed the broker Rust crate public API to protocol/snippets/run_cli, moved the binary entry through the library, colocated broker and worker tests, documented the Rust API break, and verified cargo fmt, cargo clippy -D warnings, and cargo test --release.

**Approach:** Standard approach

---

## Key Decisions

### Route broker binary through library entry point

- **Chose:** Route broker binary through library entry point
- **Reasoning:** Moving main.rs to call relay_broker::run_cli lets implementation modules live in the library crate and become pub(crate) instead of public Rust API while preserving the binary behavior.

### Keep protocol and snippets as public Rust modules

- **Chose:** Keep protocol and snippets as public Rust modules
- **Reasoning:** Current external Rust references only need snippets and the wire protocol remains the crate's intentional stable surface; broker runtime, relaycast plumbing, PTY, scheduling, metrics, and worker internals can be crate-private.

---

## Chapters

### 1. Work

_Agent: default_

- Route broker binary through library entry point: Route broker binary through library entry point
- Keep protocol and snippets as public Rust modules: Keep protocol and snippets as public Rust modules
