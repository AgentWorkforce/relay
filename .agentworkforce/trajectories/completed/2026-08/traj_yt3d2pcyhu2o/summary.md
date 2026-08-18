# Trajectory: Reserve SDK startup time before Relaycast handshake

> **Status:** ✅ Completed
> **Task:** relay#1562 review follow-up
> **Confidence:** 94%
> **Started:** August 18, 2026 at 12:44 PM
> **Completed:** August 18, 2026 at 12:47 PM

---

## Summary

Reduced the aggregate Relaycast handshake cap from 44 seconds to 40 seconds, reserving five seconds for post-port-announcement setup inside the SDK 45-second clock. Added a failing-then-passing reserve regression; 7 scoped tests, 1,014 broker tests, formatting, diff check, and scoped Clippy pass.

**Approach:** Standard approach

---

## Key Decisions

### Reserve five seconds between API announcement and handshake exhaustion
- **Chose:** Reserve five seconds between API announcement and handshake exhaustion
- **Reasoning:** The SDK starts its 45-second polling clock when the broker prints the bound port, before connection-file and startup-listener setup. A 40-second aggregate handshake cap preserves the one-membership 36.75-second schedule, still accepts measured 9.5-second responses, bounds multi-membership retries, and leaves an explicit five-second preparation and error-propagation reserve without changing the SDK.

---

## Chapters

### 1. Work
*Agent: default*

- Reserve five seconds between API announcement and handshake exhaustion: Reserve five seconds between API announcement and handshake exhaustion
