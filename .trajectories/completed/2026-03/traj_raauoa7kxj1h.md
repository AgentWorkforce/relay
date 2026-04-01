# Trajectory: Fix /openclaw origin errors by routing to standalone static site URL

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** March 4, 2026 at 02:40 PM
> **Completed:** March 4, 2026 at 02:40 PM

---

## Summary

Replaced path-mounted StaticSite + redirect Lambda with standalone StaticSite and router URL rewrite route for /openclaw; kept SSR invite route at /openclaw/invite/<token>.

**Approach:** Standard approach
