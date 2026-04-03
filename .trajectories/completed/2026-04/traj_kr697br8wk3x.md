# Trajectory: Ensure PostHog tracking is set up on docs, blog, and catalog pages

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** April 2, 2026 at 02:30 PM
> **Completed:** April 2, 2026 at 02:36 PM

---

## Summary

Added PostHog pageview tracking for the public docs/blog/catalog-style web routes using NEXT_PUBLIC_POSTHOG_KEY from GitHub Actions, with invite-token routes excluded and verification via tests plus next build.

**Approach:** Standard approach

---

## Key Decisions

### Use manual, allowlisted PostHog pageviews in the web app
- **Chose:** Use manual, allowlisted PostHog pageviews in the web app
- **Reasoning:** The web app has private invite-token routes, so blanket autocapture or automatic pageview tracking could leak sensitive URLs. Manual route-matched pageviews cover docs/blog/catalog while excluding invite paths.

---

## Chapters

### 1. Work
*Agent: default*

- Use manual, allowlisted PostHog pageviews in the web app: Use manual, allowlisted PostHog pageviews in the web app
