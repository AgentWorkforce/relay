# Trajectory: Fix attach terminal reconnect over cast.agentrelay.com

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 19, 2026 at 07:02 PM
> **Completed:** September 19, 2026 at 07:21 PM

---

## Summary

Expired fleet terminal sessions are refreshed once during attach reconnects; 410 resumes refresh while transient failures preserve the bounded resume budget.

**Approach:** Standard approach

---

## Key Decisions

### Refresh an expired remote terminal session instead of retrying its dead resume token
- **Chose:** Refresh an expired remote terminal session instead of retrying its dead resume token
- **Reasoning:** Cast terminal sessions expire after ten minutes; the CLI ignored expires_at, so a later transport flap made every bounded resume attempt target an irrecoverable 401/410 session. A fresh session preserves the local attach while keeping ordinary transport failures on the existing bounded resume path.

### Reused one bounded reconnect incident for expired sessions
- **Chose:** Reused one bounded reconnect incident for expired sessions
- **Reasoning:** A replacement is allocated only for expires_at or an HTTP 401/410 resume refusal; 5xx and transient failures continue using the original resume budget.

---

## Chapters

### 1. Work
*Agent: default*

- Refresh an expired remote terminal session instead of retrying its dead resume token: Refresh an expired remote terminal session instead of retrying its dead resume token
- Reused one bounded reconnect incident for expired sessions: Reused one bounded reconnect incident for expired sessions
- Attach proxy now swaps the terminal session only when expiry is proven; focused lifecycle tests and monorepo typecheck pass.
