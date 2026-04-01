# Trajectory: Review and confirm relay-pty cloud build decision

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 16, 2026 at 07:25 AM
> **Completed:** January 16, 2026 at 07:25 AM

---

## Summary

Confirmed Option B (multi-stage Docker build) for relay-pty cloud deployment. Key: put in Dockerfile not Dockerfile.base. Concern noted: arm64 QEMU builds slow but acceptable.

**Approach:** Standard approach

---

## Key Decisions

### Confirmed Option B: Multi-stage Docker build for relay-pty
- **Chose:** Confirmed Option B: Multi-stage Docker build for relay-pty
- **Reasoning:** Reviewed 3 options. Option A bloats image with 500MB Rust toolchain. Option C requires musl cross-compile setup and doesn't keep binary in sync. Option B gives clean final image, automatic sync between source and binary, and Docker layer caching. One concern: arm64 builds under QEMU will be slow (~10-15 min) but acceptable for CI. Multi-stage should go in Dockerfile (not Dockerfile.base) so relay-pty rebuilds only when its source changes.

### Multi-stage build goes in Dockerfile, not Dockerfile.base
- **Chose:** Multi-stage build goes in Dockerfile, not Dockerfile.base
- **Reasoning:** Dockerfile.base is for rarely-changing CLI tools. relay-pty source will change frequently. Putting multi-stage in main Dockerfile means: base image stays fast/small, relay-pty only rebuilds when source changes, layer cache handles unchanged cases.

---

## Chapters

### 1. Work
*Agent: default*

- Confirmed Option B: Multi-stage Docker build for relay-pty: Confirmed Option B: Multi-stage Docker build for relay-pty
- Multi-stage build goes in Dockerfile, not Dockerfile.base: Multi-stage build goes in Dockerfile, not Dockerfile.base
