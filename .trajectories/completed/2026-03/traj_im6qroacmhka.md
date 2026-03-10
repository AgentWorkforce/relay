# Trajectory: Record routing decision for /openclaw static rewrite

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** March 4, 2026 at 02:40 PM
> **Completed:** March 4, 2026 at 02:40 PM

---

## Summary

Recorded final routing approach: /openclaw path rewrites to static site root via Router URL route while /openclaw/invite remains Lambda SSR.

**Approach:** Standard approach

---

## Key Decisions

### Use router.route rewrite for /openclaw static page

- **Chose:** Use router.route rewrite for /openclaw static page
- **Reasoning:** Maps both /openclaw and /openclaw/ to static site root without path-mounted StaticSite edge cases

---

## Chapters

### 1. Work

_Agent: default_

- Use router.route rewrite for /openclaw static page: Use router.route rewrite for /openclaw static page
