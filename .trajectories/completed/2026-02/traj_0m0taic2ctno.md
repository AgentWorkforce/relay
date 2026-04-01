# Trajectory: Stabilize build and tests for relay-cli-uses-broker

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** February 26, 2026 at 03:16 PM
> **Completed:** February 26, 2026 at 03:21 PM

---

## Summary

Fixed failing test suite by correcting up command broker-guard regression and aligning tests with current CLI/dashboard and relay-pty path behavior

**Approach:** Standard approach

---

## Key Decisions

### Restored strict active-broker guard for up; only start/dashboard reuses existing broker

- **Chose:** Restored strict active-broker guard for up; only start/dashboard reuses existing broker
- **Reasoning:** Prevent duplicate broker starts while preserving intentional start dashboard reuse behavior

---

## Chapters

### 1. Work

_Agent: default_

- Restored strict active-broker guard for up; only start/dashboard reuses existing broker: Restored strict active-broker guard for up; only start/dashboard reuses existing broker
