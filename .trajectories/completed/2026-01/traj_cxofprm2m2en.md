# Trajectory: Fix Nango popup blocked by browser - use constructor pattern

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 3, 2026 at 10:18 PM
> **Completed:** January 3, 2026 at 10:18 PM

---

## Summary

Fixed popup:blocked_by_browser error by using Nango constructor pattern: new Nango({ connectSessionToken }) instead of setSessionToken(). Updated login, signup, and connect-repos pages to match prpm app pattern.

**Approach:** Standard approach

---

## Key Decisions

### Pass connectSessionToken to Nango constructor instead of using setSessionToken()
- **Chose:** Pass connectSessionToken to Nango constructor instead of using setSessionToken()
- **Reasoning:** The prpm app pattern works: new Nango({ connectSessionToken }) followed by openConnectUI(). This differs from our broken approach of new Nango() + setSessionToken() + open(). When the token is passed via constructor, Nango internally handles the popup differently and avoids browser popup blockers.

---

## Chapters

### 1. Work
*Agent: default*

- Pass connectSessionToken to Nango constructor instead of using setSessionToken(): Pass connectSessionToken to Nango constructor instead of using setSessionToken()
