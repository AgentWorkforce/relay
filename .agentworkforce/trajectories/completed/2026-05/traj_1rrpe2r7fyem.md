# Trajectory: Use streaming PTY input in CLI drive

> **Status:** ✅ Completed
> **Task:** github-924
> **Confidence:** 90%
> **Started:** May 20, 2026 at 03:20 AM
> **Completed:** May 20, 2026 at 03:26 AM

---

## Summary

Updated drive and passthrough CLI sessions to open SDK PTY input streams before raw-mode stdin takeover, kept Relay flush/delivery paths unchanged, and added CLI tests for stream writes and open failures.

**Approach:** Standard approach

---

## Key Decisions

### Drive and passthrough now use SDK PTY input streams

- **Chose:** Drive and passthrough now use SDK PTY input streams
- **Reasoning:** Both CLI modes represent direct human terminal input, so they should use AgentRelayClient.openInputStream while Relay messages continue through delivery and flush APIs.

---

## Chapters

### 1. Work

_Agent: default_

- Drive and passthrough now use SDK PTY input streams: Drive and passthrough now use SDK PTY input streams
