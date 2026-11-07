# Trajectory: Move docs sidebar into the mobile hamburger menu

> **Status:** ✅ Completed
> **Confidence:** 78%
> **Started:** April 10, 2026 at 12:29 PM
> **Completed:** April 10, 2026 at 12:32 PM

---

## Summary

Moved docs navigation into the hamburger menu on mobile, hid the separate mobile docs rail, and kept the desktop sidebar unchanged. Verification was partial because the web build still hit the repo's intermittent page-data failure after compile and type-check.

**Approach:** Standard approach

---

## Key Decisions

### Collapsed the mobile docs sidebar into the hamburger menu instead of rendering it above the content rail

- **Chose:** Collapsed the mobile docs sidebar into the hamburger menu instead of rendering it above the content rail
- **Reasoning:** On small screens the left rail consumes vertical space and duplicates navigation. Passing a mobile-only DocsNav into SiteNav keeps the docs tree available from the existing hamburger while preserving the desktop sidebar unchanged.

---

## Chapters

### 1. Work

_Agent: default_

- Collapsed the mobile docs sidebar into the hamburger menu instead of rendering it above the content rail: Collapsed the mobile docs sidebar into the hamburger menu instead of rendering it above the content rail
