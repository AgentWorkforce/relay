# Trajectory: Validate README onboarding: fresh-clone clone-to-running pass, closing doc/setup gaps

> **Status:** ✅ Completed
> **Task:** readme-onboarding
> **Confidence:** 85%
> **Started:** June 19, 2026 at 04:02 AM
> **Completed:** June 19, 2026 at 04:20 AM

---

## Summary

Validated README onboarding via repeated fresh clones. Closed the unstated-prerequisites gap (Node>=20.9/Node22, git, optional Rust) and added offline build/test + cloud-gated live-run docs. Verified clean clone->build->test pass twice: with Rust and with Rust simulated absent (prebuilt npm broker), 968 tests green both times.

**Approach:** Standard approach

---

## Key Decisions

### Documented run path = README Development section (npm install/build/test); it passes offline from a fresh clone. Live broker (local up) requires hosted relaycast cloud and cannot run offline.
- **Chose:** Documented run path = README Development section (npm install/build/test); it passes offline from a fresh clone. Live broker (local up) requires hosted relaycast cloud and cannot run offline.
- **Reasoning:** build:rust hardcodes gateway.relaycast.dev with no offline override; gateway returns 403 in restricted env. Offline-verifiable clean pass = install+build+test; live run is cloud-gated and must be documented as such, not as a quiet assumption.

---

## Chapters

### 1. Work
*Agent: default*

- Documented run path = README Development section (npm install/build/test); it passes offline from a fresh clone. Live broker (local up) requires hosted relaycast cloud and cannot run offline.: Documented run path = README Development section (npm install/build/test); it passes offline from a fresh clone. Live broker (local up) requires hosted relaycast cloud and cannot run offline.

---

## Artifacts

**Commits:** 8fb8de7
**Files changed:** 1
