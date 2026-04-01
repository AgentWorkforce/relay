# Trajectory: Fix relay-pty binary path resolution after package extraction

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** January 22, 2026 at 03:11 PM
> **Completed:** January 22, 2026 at 03:11 PM

---

## Summary

Fixed relay-pty binary path resolution in wrapper, daemon, bridge, and cloud packages. Each needed correct level count to traverse from packages/X/dist to project root.

**Approach:** Standard approach

---

## Key Decisions

### Changed path traversal levels for __dirname-based binary discovery
- **Chose:** Changed path traversal levels for __dirname-based binary discovery
- **Reasoning:** After packages moved to packages/*/, __dirname changed from dist/X to packages/X/dist - requires more levels up to reach project root where bin/relay-pty lives

---

## Chapters

### 1. Work
*Agent: default*

- Changed path traversal levels for __dirname-based binary discovery: Changed path traversal levels for __dirname-based binary discovery
