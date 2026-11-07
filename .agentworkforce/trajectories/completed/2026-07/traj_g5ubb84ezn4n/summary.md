# Trajectory: Fix garbled mouse-report output in 'agent attach --mode view'

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** July 15, 2026 at 06:42 PM
> **Completed:** July 15, 2026 at 06:48 PM

---

## Summary

Added InputReportModeFilter to attach-view.ts: strips mouse/focus/paste input-report DECSET enables from snapshot and live PTY output in read-only view mode, fixing echoed ^[[<35;...M garbage. 12 new unit tests + 1 session test; changelog updated.

**Approach:** Standard approach

---

## Key Decisions

### Strip input-report DECSET enables from view-mode output instead of putting stdin into raw mode

- **Chose:** Strip input-report DECSET enables from view-mode output instead of putting stdin into raw mode
- **Reasoning:** view is read-only: nobody consumes the mouse/focus/paste reports those modes make the local terminal emit, so over cooked echoing stdin they render as garbage. Filtering the enables (9,1000-1007,1015,1016,2004) at the stream level prevents the terminal from ever generating reports, keeps local mouse selection/scrollback working, and needs no stdin ownership; drive/passthrough keep the modes since they forward input. A stateful filter handles CSIs split across worker_stream frames.

---

## Chapters

### 1. Work

_Agent: default_

- Strip input-report DECSET enables from view-mode output instead of putting stdin into raw mode: Strip input-report DECSET enables from view-mode output instead of putting stdin into raw mode

---

## Artifacts

**Commits:** 701e875
**Files changed:** 4
