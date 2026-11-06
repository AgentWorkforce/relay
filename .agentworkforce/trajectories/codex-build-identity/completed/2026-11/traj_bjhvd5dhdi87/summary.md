# Trajectory: Keep executable release identity out of compiled messaging libraries

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** November 4, 2026 at 08:49 AM
> **Completed:** November 4, 2026 at 08:53 AM

---

## Summary

Added library-only embedded identity accessors and immutable startup installation; default constants/stamping preserved. Site/scheme remain compile-time, executable metadata/resource inputs no longer watched. Strict/fixture/build-script tests pass; all integration test targets compile with fixture. Isolated desktop version-only prototype67.342s ->1.149s, only executable rebuilt; production desktop adoption awaits profile/restructure handoff.

**Approach:** Standard approach

---

## Key Decisions

### Make build identity an executable-owned value
- **Chose:** Make build identity an executable-owned value
- **Reasoning:** A metadata dependency would propagate Cargo fingerprints into large libraries. Optional library-only embedded mode removes version/revision watches and exposes immutable startup initialization; standalone node behavior and compile-time site/scheme stay unchanged. Isolated desktop package split reduced version-only rebuild67.342s to1.149s with both libraries Fresh and executable reporting new baked identity.

---

## Chapters

### 1. Initial work
*Agent: codex-relay-desktop-speed-up*

- Make build identity an executable-owned value: Make build identity an executable-owned value
