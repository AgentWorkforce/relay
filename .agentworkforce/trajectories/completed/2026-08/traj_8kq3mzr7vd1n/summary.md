# Trajectory: Reject blank takeover and identity-reclaim agent tokens

> **Status:** ✅ Completed
> **Task:** [1608](https://github.com/AgentWorkforce/relay/pull/1608)
> **Confidence:** 90%
> **Started:** August 24, 2026 at 05:16 PM
> **Completed:** August 24, 2026 at 06:04 PM

---

## Summary

Made blank and whitespace-only agent tokens fail closed on both broker credential-reclaim paths: added the missing guard to the startup identity reclaim in `auth.rs` (covering the pre-8.2.0 rotate fallback in the same check) and pinned the already-shipped relaycast takeover guard in `ws.rs`, with must-fire regression tests for the empty, whitespace, tab/newline and null cases on each.

**Approach:** Read the shipped guard before changing it, pinned it with coverage verified to fail when the guard is neutralised, then closed the genuinely unguarded startup path at the point where both the recovery response and the legacy rotate fallback converge.

---

## Key Decisions

### Pin the shipped relaycast takeover guard with must-fire coverage rather than rewriting it

- **Chose:** Pin the shipped relaycast takeover guard with must-fire coverage rather than rewriting it
- **Reasoning:** The `response.token.trim().is_empty()` guard in `take_over_agent_identity` already shipped in 11.8.2 via #1596, but `MissingToken` had exactly one reference in the tree — the raise site — so nothing pinned it. Rewriting a correct guard would churn a released path; the real gap was coverage. Each test asserts the takeover mock is hit twice, because the damage a blank token does is not the return value but `seed_agent_token` poisoning the SDK credential cache, after which every later call authenticates as `Bearer ` and the engine's 401 misdirects to auth.

### Guard the resolved token in admit_agent_registration instead of at the recovery call site

- **Chose:** Guard the resolved token in admit_agent_registration instead of at the recovery call site
- **Reasoning:** The broker's startup reclaim in `auth.rs` had no blank-token check at all: a 200 from the recovery route was destructured straight into the session credential. The pre-8.2.0 rotate fallback returns a token from a different route into the same binding, so guarding the resolved `token_response` covers both arms with one check, while guarding at the recovery call would leave the fallback open. This is the path PR #1608 converts from `recover` to audited `takeover`, so the guard holds under either engine contract.

---

## Chapters

### 1. Initial work

_Agent: relay-takeover-token_

- Pin the shipped relaycast takeover guard with must-fire coverage rather than rewriting it
- Guard the resolved token in admit_agent_registration instead of at the recovery call site
- Verified must-fire by neutralising the guard: the empty, whitespace and tab/newline cases fail without it, while the null case fails one layer earlier at deserialisation and so holds either way. Full broker lib suite is green apart from five pre-existing spawner git-hook failures that reproduce unchanged on the base commit.

---

## Artifacts

**Commits:** b3f354a23, f362c8900
**Files changed:** 3
