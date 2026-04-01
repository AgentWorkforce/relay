# Trajectory: Force default PostHog host for stars tracking

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** February 12, 2026 at 10:18 PM
> **Completed:** February 12, 2026 at 10:18 PM

---

## Summary

Removed POSTHOG_HOST override and set stars workflow to always post to https://us.i.posthog.com; updated README setup steps

**Approach:** Standard approach

---

## Key Decisions

### Hardcode PostHog host to US ingest for stars workflow
- **Chose:** Hardcode PostHog host to US ingest for stars workflow
- **Reasoning:** User requested fixed default host; removing host override keeps configuration simple and consistent

---

## Chapters

### 1. Work
*Agent: default*

- Hardcode PostHog host to US ingest for stars workflow: Hardcode PostHog host to US ingest for stars workflow
