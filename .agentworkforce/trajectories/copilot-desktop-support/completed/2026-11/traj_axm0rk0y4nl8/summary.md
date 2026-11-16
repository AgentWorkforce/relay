# Trajectory: Support standalone GitHub Copilot desktop sessions

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** November 15, 2026 at 10:31 PM
> **Completed:** November 15, 2026 at 10:33 PM

---

## Summary

Verified standalone Copilot desktop runtime ancestry and held session identity; 51 native tests and the read-only installed GitHub-signed runtime proof pass. Combined the reviewed stop-hook startup race fix for the desktop pin.

**Approach:** Standard approach

---

## Key Decisions

### Reuse native Copilot hook and history routes with GitHub-signed desktop ancestry
- **Chose:** Reuse native Copilot hook and history routes with GitHub-signed desktop ancestry
- **Reasoning:** Desktop1.4.2 holds native session inodes under the existing Copilot history root; preserve exact chat identity and the single RelayHistory parser.

---

## Chapters

### 1. Work
*Agent: default*

- Reuse native Copilot hook and history routes with GitHub-signed desktop ancestry: Reuse native Copilot hook and history routes with GitHub-signed desktop ancestry

---

## Artifacts

**Commits:** 20b17cb57, d273c4c00
**Files changed:** 16
