# Trajectory: Remove OpenClaw skill copy step and reference canonical markdown directly

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** March 4, 2026 at 03:25 PM
> **Completed:** March 4, 2026 at 03:25 PM

---

## Summary

Removed sync/copy workflow, switched to direct SKILL.md file reference, and configured Next tracing includes for deployment packaging.

**Approach:** Standard approach

---

## Key Decisions

### Read packages/openclaw/skill/SKILL.md directly in Next server components

- **Chose:** Read packages/openclaw/skill/SKILL.md directly in Next server components
- **Reasoning:** Eliminates drift from copied content and keeps a single source of truth for OpenClaw instructions

### Enable Next output file tracing for external SKILL.md path

- **Chose:** Enable Next output file tracing for external SKILL.md path
- **Reasoning:** Ensures SST/Next deployment bundles the monorepo file even though it lives outside openclaw-web

---

## Chapters

### 1. Work

_Agent: default_

- Read packages/openclaw/skill/SKILL.md directly in Next server components: Read packages/openclaw/skill/SKILL.md directly in Next server components
- Enable Next output file tracing for external SKILL.md path: Enable Next output file tracing for external SKILL.md path
