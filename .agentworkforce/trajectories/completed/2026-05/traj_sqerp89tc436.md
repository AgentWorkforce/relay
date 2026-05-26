# Trajectory: Remove legacy root bin fallback

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 18, 2026 at 08:45 PM
> **Completed:** May 18, 2026 at 08:50 PM

---

## Summary

Removed the stale repository-root bin placeholder and resolver fallbacks that searched it. Broker resolution now stops at active SDK/optional-dep/Cargo/PATH locations, relay-pty no longer probes source-checkout root bin, and release/build scripts no longer reference root bin artifacts.

**Approach:** Standard approach

---

## Key Decisions

### Apply issue 875 to crates/broker/src/main.rs

- **Chose:** Apply issue 875 to crates/broker/src/main.rs
- **Reasoning:** The broker binary was moved under crates/broker after the issue text was written, so the current main.rs entrypoint now lives there.

### Removed repository-root bin fallback

- **Chose:** Removed repository-root bin fallback
- **Reasoning:** The root bin directory only contained .gitkeep, production broker binaries resolve through optional packages, and local development resolves through Cargo target or SDK bin paths.

---

## Chapters

### 1. Work

_Agent: default_

- Apply issue 875 to crates/broker/src/main.rs: Apply issue 875 to crates/broker/src/main.rs
- Removed repository-root bin fallback: Removed repository-root bin fallback

---

## Artifacts

**Commits:** 040e6d9f
