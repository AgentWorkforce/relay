# Trajectory: Implement agent-relay operator session auto-refresh

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** June 17, 2026 at 09:28 PM
> **Completed:** June 17, 2026 at 09:34 PM

---

## Summary

Preserved cloud operator refresh-token expiry metadata in @agent-relay/cloud, refreshed canonical sessions before access/refresh renewal windows, exposed refresh expiry through agent-relay cloud session, and verified targeted tests plus package typechecks.

**Approach:** Standard approach

---

## Key Decisions

### Preserve refresh token expiry and proactively refresh cloud sessions
- **Chose:** Preserve refresh token expiry and proactively refresh cloud sessions
- **Reasoning:** Cloud and relayauth return refreshTokenExpiresAt for durable operator sessions; agent-relay must store it and refresh before access or refresh renewal windows so sibling CLIs can consume one canonical session without browser re-login.

---

## Chapters

### 1. Work
*Agent: default*

- Preserve refresh token expiry and proactively refresh cloud sessions: Preserve refresh token expiry and proactively refresh cloud sessions
