# Trajectory: Fix 404 errors on auth endpoints

> **Status:** ✅ Completed
> **Task:** api-auth-session-404
> **Confidence:** 90%
> **Started:** January 3, 2026 at 08:55 PM
> **Completed:** January 3, 2026 at 10:14 PM

---

## Summary

Fixed Nango OAuth popup blocker issue in login and signup pages by reordering operations to open popup synchronously before async token fetch

**Approach:** Standard approach

---

## Key Decisions

### Fixed Nango integration: updated to use Nango Proxy for GitHub API calls, fixed popup blocking in OAuth flow, added missing database columns for user connection tracking
- **Chose:** Fixed Nango integration: updated to use Nango Proxy for GitHub API calls, fixed popup blocking in OAuth flow, added missing database columns for user connection tracking
- **Reasoning:** Using Nango Proxy instead of direct token fetches provides automatic token refresh and cleaner code. Database schema was missing nango_connection_id, incoming_connection_id, and pending_installation_request columns needed for the two-connection OAuth pattern.

### Fixed popup:blocked_by_browser error by opening Nango Connect UI synchronously before async session fetch
- **Chose:** Fixed popup:blocked_by_browser error by opening Nango Connect UI synchronously before async session fetch
- **Reasoning:** Browser popup blockers require window.open() to be called synchronously within the user's click event handler. Awaiting the session token first broke the gesture chain. Solution: open popup immediately (shows loading), then fetch token async, then set token to enable the UI.

---

## Chapters

### 1. Work
*Agent: default*

- Fixed Nango integration: updated to use Nango Proxy for GitHub API calls, fixed popup blocking in OAuth flow, added missing database columns for user connection tracking: Fixed Nango integration: updated to use Nango Proxy for GitHub API calls, fixed popup blocking in OAuth flow, added missing database columns for user connection tracking
- Fixed popup:blocked_by_browser error by opening Nango Connect UI synchronously before async session fetch: Fixed popup:blocked_by_browser error by opening Nango Connect UI synchronously before async session fetch
