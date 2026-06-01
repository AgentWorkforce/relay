# Trajectory: Fix OpenClaw skill route build failure

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** June 1, 2026 at 05:52 PM
> **Completed:** June 1, 2026 at 06:00 PM

---

## Summary

Fixed the OpenClaw skill web route by bundling SKILL.md as a raw markdown asset, added web test wiring and regression coverage, and verified Next/OpenNext builds.

**Approach:** Standard approach

---

## Key Decisions

### Bundled OpenClaw SKILL.md as a raw webpack asset
- **Chose:** Bundled OpenClaw SKILL.md as a raw webpack asset
- **Reasoning:** OpenNext static generation should not depend on runtime fs path guessing outside the web bundle.

---

## Chapters

### 1. Work
*Agent: default*

- Bundled OpenClaw SKILL.md as a raw webpack asset: Bundled OpenClaw SKILL.md as a raw webpack asset
