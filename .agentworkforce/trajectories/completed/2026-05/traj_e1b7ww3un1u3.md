# Trajectory: Harden agents logs raw and follow output

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 19, 2026 at 12:59 PM
> **Completed:** May 19, 2026 at 01:04 PM

---

## Summary

Hardened agents:logs raw output to write Buffer bytes unchanged and made cooked follow preserve split ANSI CSI and UTF-8 sequences across poll chunks

**Approach:** Standard approach

---

## Key Decisions

### Use Buffer reads for raw agents logs and stream byte chunks through cooked follow

- **Chose:** Use Buffer reads for raw agents logs and stream byte chunks through cooked follow
- **Reasoning:** Raw output must avoid UTF-8 decoding entirely, while cooked follow needs TextDecoder streaming so multibyte codepoints split by polling are reconstructed before ANSI replay

---

## Chapters

### 1. Work

_Agent: default_

- Use Buffer reads for raw agents logs and stream byte chunks through cooked follow: Use Buffer reads for raw agents logs and stream byte chunks through cooked follow
