# Trajectory: Fix macOS CI npx binary resolution test

> **Status:** ✅ Completed
> **Task:** PR-344
> **Confidence:** 95%
> **Started:** January 29, 2026 at 11:03 AM
> **Completed:** January 29, 2026 at 11:12 AM

---

## Summary

Fixed macOS CI test by testing from installed package directory instead of running npx with tarball path directly. Root cause was npx /path/to/tarball.tgz failing with exit 126 on macOS. All CI tests now pass including macOS arm64, Node 18/20/22, and Docker tests.

**Approach:** Standard approach

---

## Key Decisions

### Test from installed package directory instead of running npx with tarball path
- **Chose:** Test from installed package directory instead of running npx with tarball path
- **Reasoning:** Running 'npx /path/to/tarball.tgz' directly fails with exit 126 on macOS. Instead, test binary resolution from the already-installed /tmp/test-project directory, which better simulates real-world usage where users install the package first.

---

## Chapters

### 1. Work
*Agent: default*

- Test from installed package directory instead of running npx with tarball path: Test from installed package directory instead of running npx with tarball path
