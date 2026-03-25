# Trajectory: PTY output streaming: rate-limited buffering, stream filter, and Devin review fixes

> **Status:** ✅ Completed
> **Task:** 390
> **Confidence:** 90%
> **Started:** March 25, 2026 at 10:28 AM
> **Completed:** March 25, 2026 at 10:28 AM

---

## Summary

Implemented PTY output streaming improvements: rate-limited buffering in Rust (4KB/100ms), SDK onOutput stream filter and explicit mode option, flush_stream_buffer macro to eliminate duplication, and consistent buffer flushing across all 3 exit paths (/exit, PTY-close, watchdog). Addressed all Devin review findings.

**Approach:** Standard approach

---

## Key Decisions

### Added rate-limited buffering to worker_stream emissions in Rust PTY worker
- **Chose:** Added rate-limited buffering to worker_stream emissions in Rust PTY worker
- **Reasoning:** Raw per-chunk worker_stream frames caused excessive frame noise. Buffer up to 4KB or 100ms before flushing to reduce overhead while maintaining low latency.

### Added stream filter option to SDK onOutput
- **Chose:** Added stream filter option to SDK onOutput
- **Reasoning:** Callers needed to filter by stdout/stderr without manually checking every event. Added optional { stream: 'stdout' } parameter to onOutput() so listeners only fire for matching streams.

### Extracted flush_stream_buffer\! macro to eliminate 5x code duplication
- **Chose:** Extracted flush_stream_buffer\! macro to eliminate 5x code duplication
- **Reasoning:** Devin review identified that the identical buffer flush pattern was copy-pasted at 5 locations, causing bugs where fixes applied to one site didn't propagate. Prior commits had patched PTY-close and watchdog paths but missed the /exit path — proving the DRY violation was the root cause.

### Added explicit mode option to onOutput to bypass toString() heuristic
- **Chose:** Added explicit mode option to onOutput to bypass toString() heuristic
- **Reasoning:** inferOutputMode used callback.toString() to detect structured vs chunk mode, which silently breaks with minifiers — defaulting to chunk mode. Combined with the new stream filter, a developer could think they're filtering structured events but receive unfiltered raw strings. Added explicit { mode: 'structured' } option as escape hatch.

### Inlined post-loop flush instead of using macro to avoid CI unused-assignment error
- **Chose:** Inlined post-loop flush instead of using macro to avoid CI unused-assignment error
- **Reasoning:** The flush_stream_buffer! macro always updates stream_buffer_last_flush, but after the main loop this timestamp is never read. CI treats warnings as errors (-D warnings), so the post-loop site inlines the flush without the timestamp update.

---

## Chapters

### 1. Work
*Agent: default*

- Added rate-limited buffering to worker_stream emissions in Rust PTY worker: Added rate-limited buffering to worker_stream emissions in Rust PTY worker
- Added stream filter option to SDK onOutput: Added stream filter option to SDK onOutput
- Extracted flush_stream_buffer\! macro to eliminate 5x code duplication: Extracted flush_stream_buffer\! macro to eliminate 5x code duplication
- Added explicit mode option to onOutput to bypass toString() heuristic: Added explicit mode option to onOutput to bypass toString() heuristic
- Inlined post-loop flush instead of using macro to avoid CI unused-assignment error: Inlined post-loop flush instead of using macro to avoid CI unused-assignment error
- All Devin review issues addressed. Three exit paths (PTY-close, watchdog, /exit) now consistently flush stream_buffer before agent_exit. DRY macro prevents future regressions. SDK stream filter and explicit mode option complete the feature.
