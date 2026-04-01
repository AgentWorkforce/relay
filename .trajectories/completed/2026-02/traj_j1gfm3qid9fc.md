# Trajectory: Fix local dashboard proxy/trajectory failures in up mode

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** February 23, 2026 at 08:43 AM
> **Completed:** February 23, 2026 at 08:43 AM

---

## Summary

Started broker before dashboard in up mode, adjusted local dashboard launch env/args to avoid dead :3889 proxy, added local bridge/trajectory endpoints in dashboard-server, and verified /api/bridge /api/trajectory* /ws

**Approach:** Standard approach

---

## Key Decisions

### Default local JS dashboard launches to standalone mode with local API fallbacks
- **Chose:** Default local JS dashboard launches to standalone mode with local API fallbacks
- **Reasoning:** local dashboard 2.0.82 assumes relay proxy on :3889 by default, but CLI up uses stdio broker init; forcing standalone avoids dead proxy/ws paths while preserving explicit relay override

---

## Chapters

### 1. Work
*Agent: default*

- Default local JS dashboard launches to standalone mode with local API fallbacks: Default local JS dashboard launches to standalone mode with local API fallbacks
