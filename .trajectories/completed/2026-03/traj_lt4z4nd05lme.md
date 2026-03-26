# Trajectory: Use browser/system theme as the default for the web app

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** March 25, 2026 at 06:34 PM
> **Completed:** March 25, 2026 at 06:34 PM

---

## Summary

Made the web app follow the browser/system color preference by default, with saved light/dark choices now acting only as explicit overrides.

**Approach:** Standard approach

---

## Key Decisions

### Changed the theme fallback from app-selected light/dark to browser-native system preference
- **Chose:** Changed the theme fallback from app-selected light/dark to browser-native system preference
- **Reasoning:** When there is no saved override, the app should let prefers-color-scheme drive the tokens and color-scheme directly. That matches browser expectations better than eagerly writing a concrete theme on first load.

---

## Chapters

### 1. Work
*Agent: default*

- Changed the theme fallback from app-selected light/dark to browser-native system preference: Changed the theme fallback from app-selected light/dark to browser-native system preference
