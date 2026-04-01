# Trajectory: Fix header to show correct channel name

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** January 20, 2026 at 08:55 PM
> **Completed:** January 20, 2026 at 08:56 PM

---

## Summary

Fixed header to show correct channel name when in channels view. Added viewMode and selectedChannelName props to Header component. Now displays #random when viewing #random instead of always showing #general.

**Approach:** Standard approach

---

## Key Decisions

### Added viewMode and selectedChannelName props to Header
- **Chose:** Added viewMode and selectedChannelName props to Header
- **Reasoning:** Header was using currentChannel which is for the old message view. In channels view, it needs to know about viewMode and the selected channel name to display correctly.

---

## Chapters

### 1. Work
*Agent: default*

- Added viewMode and selectedChannelName props to Header: Added viewMode and selectedChannelName props to Header
