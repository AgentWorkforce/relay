# Trajectory: Fix build failures and remove remaining subprocess calls

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** March 27, 2026 at 02:13 PM
> **Completed:** March 27, 2026 at 02:20 PM

---

## Summary

Removed shell execs from relay on-flow, fixed TypeScript errors, and restored @relayauth/core require() compatibility

**Approach:** Standard approach

---

## Key Decisions

### Replaced shell-based on-command helpers with in-process parsing and direct child-process capture
- **Chose:** Replaced shell-based on-command helpers with in-process parsing and direct child-process capture
- **Reasoning:** Provisioning only needed relay config ACL counts, so YAML/JSON parsing is safer than npx tsx shells; the one-time relayfile sync still needs the mount binary, but capture via spawn avoids execFileSync and keeps errors explicit.

---

## Chapters

### 1. Work
*Agent: default*

- Replaced shell-based on-command helpers with in-process parsing and direct child-process capture: Replaced shell-based on-command helpers with in-process parsing and direct child-process capture
