# Trajectory: Adjust readiness behavior to allow slower agent spawn and avoid 30s worker_ready timeout

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 27, 2026 at 10:03 PM
> **Completed:** February 27, 2026 at 10:04 PM

---

## Summary

Adjusted readiness behavior to tolerate slower startup: SDK waitForReady defaults now 60s and Codex relaycast boot-marker detection now works across PTY chunk boundaries. Kept non-fail-fast semantics.

**Approach:** Standard approach

---

## Key Decisions

### Prefer longer waitForReady defaults instead of fail-fast
- **Chose:** Prefer longer waitForReady defaults instead of fail-fast
- **Reasoning:** User wants slower agent startups tolerated. Increased SDK worker_ready wait defaults from 30s to 60s and kept readiness flow timeout-driven.

### Detect Codex relaycast boot marker across chunk boundaries
- **Chose:** Detect Codex relaycast boot marker across chunk boundaries
- **Reasoning:** Previous gating searched only current PTY chunk and could miss split markers, delaying worker_ready until timeout. Now scans accumulated startup output and tracks post-boot prompt window robustly.

---

## Chapters

### 1. Work
*Agent: default*

- Prefer longer waitForReady defaults instead of fail-fast: Prefer longer waitForReady defaults instead of fail-fast
- Detect Codex relaycast boot marker across chunk boundaries: Detect Codex relaycast boot marker across chunk boundaries
