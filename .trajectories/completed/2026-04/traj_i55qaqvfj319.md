# Trajectory: Align docs right sidebar language block with left sidebar section heading

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** April 2, 2026 at 01:03 PM
> **Completed:** April 2, 2026 at 01:05 PM

---

## Summary

Aligned the docs TOC rail so the Language heading lines up with the left nav section heading by sharing desktop top-padding values and offsetting the TOC rail instead of moving article content. Verified with a successful Next.js production build using --no-lint; the standard build is still blocked by unrelated existing lint issues in app/auth/RelayauthAnimation.tsx and components/FaqSection.tsx.

**Approach:** Standard approach

---

## Key Decisions

### Aligned docs right rail label offsets with left nav headings using shared padding variables
- **Chose:** Aligned docs right rail label offsets with left nav headings using shared padding variables
- **Reasoning:** The left sidebar and content column used different top paddings, and the TOC added extra padding. Moving only the TOC with shared CSS variables fixes the visual mismatch without shifting article content.

---

## Chapters

### 1. Work
*Agent: default*

- Aligned docs right rail label offsets with left nav headings using shared padding variables: Aligned docs right rail label offsets with left nav headings using shared padding variables
