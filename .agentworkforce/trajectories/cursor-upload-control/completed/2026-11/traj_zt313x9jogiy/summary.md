# Trajectory: Preserve archived Cursor classification during identity upgrade

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** November 19, 2026 at 11:40 AM
> **Completed:** November 19, 2026 at 11:41 AM

---

## Summary

Reproduced loss of Archived classification for durable cursor-cli keys after the upload identity change. Added the canonical history key while retaining the old key at store decode. All 97 relay store tests pass, including the new regression, round trip, and existing Claude archive coverage.

**Approach:** Standard approach

---

## Key Decisions

### Retain old archive keys and add the canonical history identity during store decoding
- **Chose:** Retain old archive keys and add the canonical history identity during store decoding
- **Reasoning:** A failing regression proves archived Cursor chats otherwise lose their Archived classification once their bounded recent archive entry is gone. The migration preserves compatibility and stabilizes after the first upgrade.

---

## Chapters

### 1. Initial work
*Agent: codex-cursor-upload*

- Retain old archive keys and add the canonical history identity during store decoding: Retain old archive keys and add the canonical history identity during store decoding
