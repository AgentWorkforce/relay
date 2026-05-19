# Trajectory: Fix issue 876

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#876
> **Confidence:** 92%
> **Started:** May 18, 2026 at 10:48 PM
> **Completed:** May 18, 2026 at 10:56 PM

---

## Summary

Refactored broker helpers.rs into domain-owned modules, updated all imports, moved helper tests with the code, and validated Rust check/test/fmt/clippy plus SDK TypeScript check.

**Approach:** Standard approach

---

## Key Decisions

### Split broker helpers by ownership

- **Chose:** Split broker helpers by ownership
- **Reasoning:** Issue 876 called out unrelated responsibilities in helpers.rs, so command parsing moved under cli, injection/verification/continuity under broker, ANSI and terminal prompt detection under util, worker activity detection under worker, and Relaycast identity/DM cache under relaycast-specific modules.

---

## Chapters

### 1. Work

_Agent: default_

- Split broker helpers by ownership: Split broker helpers by ownership
