# Trajectory: Fix CI for PR 1174 Relaycast SDK update

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** June 19, 2026 at 03:23 PM
> **Completed:** June 19, 2026 at 03:29 PM

---

## Summary

Hardened PR 1174 CI by retrying the SDK npm install after an ECONNRESET failure and increasing the local Codex model probe timeout so the Linux release test is not sensitive to full-suite process startup load.

**Approach:** Standard approach

---

## Key Decisions

### Hardened CI against transient install and probe timeouts

- **Chose:** Hardened CI against transient install and probe timeouts
- **Reasoning:** SDK check failed on npm ECONNRESET, and the Linux release Rust failure returned None from a process probe guarded by a tight 1.5s timeout under full-suite load.

---

## Chapters

### 1. Work

_Agent: default_

- Hardened CI against transient install and probe timeouts: Hardened CI against transient install and probe timeouts
