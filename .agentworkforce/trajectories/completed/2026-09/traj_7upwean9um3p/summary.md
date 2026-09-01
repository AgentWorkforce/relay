# Trajectory: Gate PR 1632 broker builds to same-repository heads

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 99%
> **Started:** September 1, 2026 at 09:12 PM
> **Completed:** September 1, 2026 at 09:13 PM

---

## Summary

Blocked fork-controlled code from the trusted broker builder while preserving main push, schedule, and same-repository PR artifact production, with source-contract coverage.

**Approach:** Standard approach

---

## Key Decisions

### Compile only same-repository pull request heads
- **Chose:** Compile only same-repository pull request heads
- **Reasoning:** pull_request_target workflow logic is trusted, but checking out and compiling a fork head can execute fork-controlled Cargo build scripts in that runner context. Gate the build job so push and schedule remain enabled while pull_request_target requires the head repository to equal github.repository. Fork PRs are already rejected by the proof dispatcher.

---

## Chapters

### 1. Work
*Agent: default*

- Compile only same-repository pull request heads: Compile only same-repository pull request heads
