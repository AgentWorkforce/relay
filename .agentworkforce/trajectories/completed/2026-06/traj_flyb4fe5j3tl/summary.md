# Trajectory: Build Pear landing page at /pear in web app

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** June 2, 2026 at 11:54 AM
> **Completed:** June 2, 2026 at 02:37 PM

---

## Summary

Upgraded web app from Next.js 15.5.18 to 16.2.7 and React 18.3 to 19.2. Kept webpack via --webpack flag (OpenNext runs npm run build) to preserve SKILL.md?raw build-time inlining used by a force-dynamic route. Fixed monorepo overrides to react/react-dom/@types 19 + next 16 (single-copy dedup), fixed React 19 type changes (props:unknown, removed global JSX namespace, LegacyRef), renamed middleware.ts->proxy.ts (Next 16 convention), bumped openNextVersion 3.9.16->3.10.4 for Next 16. Build clean (167 pages), tsc clean, 12/12 tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Keep webpack via --webpack flag for Next 16 upgrade
- **Chose:** Keep webpack via --webpack flag for Next 16 upgrade
- **Reasoning:** Only webpack-specific usage is SKILL.md?raw build-time inlining relied on by a force-dynamic route; Turbopack lacks resourceQuery support. OpenNext runs npm run build, so --webpack in the build script is honored in prod. Lowest risk, preserves exact behavior.

---

## Chapters

### 1. Work
*Agent: default*

- Keep webpack via --webpack flag for Next 16 upgrade: Keep webpack via --webpack flag for Next 16 upgrade

---

## Artifacts

**Commits:** f02a4ac
**Files changed:** 12
