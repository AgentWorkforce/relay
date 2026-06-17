# Trajectory: Add --cwd flag to local agent spawn and new commands

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** June 17, 2026 at 08:02 PM
> **Completed:** June 17, 2026 at 08:03 PM

---

## Summary

Added --cwd <path> option to local agent spawn and new commands; passes through to spawnPty; test added

**Approach:** Standard approach

---

## Key Decisions

### Add --cwd flag to CLI only; no broker changes needed
- **Chose:** Add --cwd flag to CLI only; no broker changes needed
- **Reasoning:** cwd was already in the full stack (broker protocol, harness-driver SpawnPtyInput, ClientSpawnOptions) — only the CLI option was missing

---

## Chapters

### 1. Work
*Agent: default*

- Add --cwd flag to CLI only; no broker changes needed: Add --cwd flag to CLI only; no broker changes needed
