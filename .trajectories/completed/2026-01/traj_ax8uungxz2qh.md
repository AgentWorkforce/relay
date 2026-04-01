# Trajectory: Fix DM participant toggle (removal not working)

> **Status:** ✅ Completed
> **Confidence:** 73%
> **Started:** January 7, 2026 at 08:10 PM
> **Completed:** January 7, 2026 at 08:26 PM

---

## Summary

DMs now render inline: human selection sets channel; DM modal removed; participant removal fixed

**Approach:** Standard approach

---

## Key Decisions

### Allow DM agent removal
- **Chose:** Allow DM agent removal
- **Reasoning:** Track removedAgents so derived participants don't re-add toggled-off agents; participant list now respects user toggles

### Show DMs inline
- **Chose:** Show DMs inline
- **Reasoning:** Removed DM modal and treat human selections as channels so DM messages appear in main conversation stream

---

## Chapters

### 1. Work
*Agent: default*

- Allow DM agent removal: Allow DM agent removal
- Show DMs inline: Show DMs inline
