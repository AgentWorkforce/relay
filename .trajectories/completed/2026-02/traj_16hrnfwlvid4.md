# Trajectory: Fix thread messages not delivered to agents and not rendered in dashboard

> **Status:** ✅ Completed
> **Confidence:** 50%
> **Started:** February 24, 2026 at 10:53 PM
> **Completed:** February 24, 2026 at 10:53 PM

---

## Summary

Previous incomplete work

**Approach:** Standard approach

---

## Key Decisions

### Added channel field to Rust SDK ThreadReplyEvent

- **Chose:** Added channel field to Rust SDK ThreadReplyEvent
- **Reasoning:** The server sends channel in thread.reply events but the Rust SDK struct was missing it, causing the broker to fall back to synthetic target 'thread' which broke dashboard routing

### Override display_target in broker main loop for thread replies

- **Chose:** Override display_target in broker main loop for thread replies
- **Reasoning:** Even with the SDK fix, added a safety net in main.rs that extracts the raw WS channel field and overrides display_target when it is 'thread' (synthetic) so the dashboard routes messages correctly

---

## Chapters

### 1. Work

_Agent: default_

- Added channel field to Rust SDK ThreadReplyEvent: Added channel field to Rust SDK ThreadReplyEvent
- Override display_target in broker main loop for thread replies: Override display_target in broker main loop for thread replies
