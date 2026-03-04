# Trajectory: Fix publish workflow musl.cc timeout for aarch64 broker build

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** March 4, 2026 at 01:18 PM
> **Completed:** March 4, 2026 at 01:18 PM

---

## Summary

Patched publish.yml build-broker job to use cross for aarch64-unknown-linux-musl, removed musl.cc curl path, and enabled fail-fast=false for broker matrix

**Approach:** Standard approach

---

## Key Decisions

### Replaced publish workflow aarch64 musl toolchain download from musl.cc with cross-rs
- **Chose:** Replaced publish workflow aarch64 musl toolchain download from musl.cc with cross-rs
- **Reasoning:** musl.cc timeouts cause recurring CI failures; cross uses maintained target container and avoids direct dependency on musl.cc

---

## Chapters

### 1. Work
*Agent: default*

- Replaced publish workflow aarch64 musl toolchain download from musl.cc with cross-rs: Replaced publish workflow aarch64 musl toolchain download from musl.cc with cross-rs
