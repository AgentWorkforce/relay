# Trajectory: Decide Rust relay-pty cloud build strategy

> **Status:** ✅ Completed
> **Task:** agent-relay-504
> **Confidence:** 95%
> **Started:** January 16, 2026 at 07:22 AM
> **Completed:** January 16, 2026 at 07:23 AM

---

## Summary

Chose multi-stage Docker build for Rust relay-pty deployment. Clean final image (no Rust toolchain), self-contained, source/binary always in sync, layer caching for fast rebuilds.

**Approach:** Standard approach

---

## Key Decisions

### Use multi-stage Docker build for Rust relay-pty
- **Chose:** Use multi-stage Docker build for Rust relay-pty
- **Reasoning:** Evaluated 4 options: (1) Build in Dockerfile - adds 500MB+ Rust toolchain to image, (2) Multi-stage build - clean final image, self-contained, standard pattern, (3) Pre-built binary from CI - requires separate workflow, sync issues, (4) Download from GitHub release - external dependency. Multi-stage is best: no toolchain bloat, source/binary always in sync, layer caching for fast rebuilds.

---

## Chapters

### 1. Work
*Agent: default*

- Use multi-stage Docker build for Rust relay-pty: Use multi-stage Docker build for Rust relay-pty
