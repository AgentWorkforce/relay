# Trajectory: Finish Relay PR #1730 overload retries and mcp-args proof

> **Status:** ✅ Completed
> **Task:** relay-1730-1715
> **Confidence:** 90%
> **Started:** September 10, 2026 at 08:01 PM
> **Completed:** September 10, 2026 at 08:07 PM

---

## Summary

Extended the broker-owned bounded Relaycast registration retry path to cli mcp-args --register, corrected the base proof marker contract, updated the changelog, and validated full broker tests plus exact base-red/head-green proof at bde1d4257d7a95484f4e3bcb86f0e3eb95124022.

**Approach:** Standard approach

---

## Key Decisions

### Extended the broker-owned bounded registration retry helper into mcp-args --register
- **Chose:** Extended the broker-owned bounded registration retry helper into mcp-args --register
- **Reasoning:** The fresh Cloud proof showed the outer RelayFlow executor retried three times while each inner mcp-args registration reported attempts:1; the existing helper already owns typed 503 classification, bounded backoff, diagnostics, and takeover-safe registration.

---

## Chapters

### 1. Work
*Agent: default*

- Extended the broker-owned bounded registration retry helper into mcp-args --register: Extended the broker-owned bounded registration retry helper into mcp-args --register
- Broker spawn is green at head and red at base; Cloud mcp-args was a separate uncovered call site and now shares the same bounded retry path. Full broker tests pass.

---

## Artifacts

**Commits:** bde1d4257
**Files changed:** 3
