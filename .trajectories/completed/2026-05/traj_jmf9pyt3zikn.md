# Trajectory: Fix issue 874

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#874
> **Confidence:** 90%
> **Started:** May 18, 2026 at 08:07 PM
> **Completed:** May 18, 2026 at 08:17 PM

---

## Summary

Moved the Rust broker crate from root src into crates/broker, converted the root Cargo manifest into a workspace, preserved root target binary paths, and updated SDK/workflow source path references.

**Approach:** Standard approach

---

## Key Decisions

### Scope issue 874 to crate relocation and path/build updates only

- **Chose:** Scope issue 874 to crate relocation and path/build updates only
- **Reasoning:** Acceptance criteria explicitly ask to preserve broker behavior and avoid functional refactors in this PR.

### Kept the root target directory by using a virtual workspace with default member crates/broker

- **Chose:** Kept the root target directory by using a virtual workspace with default member crates/broker
- **Reasoning:** The existing npm scripts, SDK tests, and integration harnesses resolve target/debug or target/release from the repository root; Cargo workspace builds preserve that output path while moving source under crates/broker.

---

## Chapters

### 1. Work

_Agent: default_

- Scope issue 874 to crate relocation and path/build updates only: Scope issue 874 to crate relocation and path/build updates only
- Kept the root target directory by using a virtual workspace with default member crates/broker: Kept the root target directory by using a virtual workspace with default member crates/broker
