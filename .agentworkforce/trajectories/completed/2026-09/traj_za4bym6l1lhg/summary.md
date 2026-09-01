# Trajectory: Isolate PR broker builds from trusted Rust cache

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 99%
> **Started:** September 1, 2026 at 09:39 PM
> **Completed:** September 1, 2026 at 09:40 PM

---

## Summary

Prevented same-repository pull_request_target broker builds from using the trusted Rust cache and added a workflow source-contract assertion. Focused 65-test suite, actionlint, Prettier, and diff checks pass.

**Approach:** Standard approach

---

## Key Decisions

### Disable Rust caching for PR-authored broker builds
- **Chose:** Disable Rust caching for PR-authored broker builds
- **Reasoning:** pull_request_target executes PR Cargo build scripts. Skipping the cache action entirely for that event prevents PR output from being restored or saved in the trusted push/schedule cache namespace, while trusted main builds retain caching.

---

## Chapters

### 1. Work
*Agent: default*

- Disable Rust caching for PR-authored broker builds: Disable Rust caching for PR-authored broker builds
