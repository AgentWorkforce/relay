# Trajectory: Pin blank takeover-token rejection with must-fire regression coverage

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** August 24, 2026 at 5:16 PM
> **Completed:** August 24, 2026 at 5:54 PM

---

## Summary

Pinned the broker's blank/whitespace takeover-token rejection with four must-fire regression tests covering empty, spaces, tab/newline and null, each asserting the unusable token is never seeded into the credential cache.

**Approach:** Standard approach

---

## Key Decisions

### Add must-fire coverage for the existing blank-token guard rather than rewrite it
- **Chose:** Add must-fire coverage for the existing blank-token guard rather than rewrite it
- **Reasoning:** The `response.token.trim().is_empty()` guard in `take_over_agent_identity` already shipped in 11.8.2 via #1596, but `MissingToken` had exactly one reference in the tree — the raise site — so nothing pinned it. Rewriting a correct guard would churn a released path; the real gap was coverage. Each test asserts the takeover mock is hit twice, because the damage a blank token does is not the return value but `seed_agent_token` poisoning the SDK credential cache, after which every later call authenticates as `Bearer ` and the engine's 401 misdirects to auth. Verified must-fire by neutralising the guard: the empty, whitespace and tab/newline cases returned Ok(""), Ok("   ") and Ok("\t\r\n  \n"). The null case is documented as failing one layer earlier, at deserialisation into the non-optional `token` field, so it holds with or without the guard.

---

## Chapters

### 1. Work
*Agent: default*

- Add must-fire coverage for the existing blank-token guard rather than rewrite it: Add must-fire coverage for the existing blank-token guard rather than rewrite it
