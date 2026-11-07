# Trajectory: Implement relay#1522 Relayhistory↔Relaycast completed-session replay join

> **Status:** ✅ Completed
> **Task:** relay#1522
> **Confidence:** 88%
> **Started:** August 19, 2026 at 09:00 AM
> **Completed:** August 19, 2026 at 09:25 AM

---

## Summary

Joined completed-session replay across per-node Relayhistory and workspace-wide Relaycast using the existing session_ref; stamped session_ref on all Relay writers; exposed and documented retention, aged-out, partial, and unknown coverage; added ordered multi-node and aged-out verification.

**Approach:** Standard approach

---

## Key Decisions

### Stamp RELAY_ATTEST_SESSION_ID on every Relay message writer before joining by session_ref
- **Chose:** Stamp RELAY_ATTEST_SESSION_ID on every Relay message writer before joining by session_ref
- **Reasoning:** Relaycast 8.0.7 indexes metadata.session_ref, but Relay channel, thread, DM, and group-message adapters previously supplied no metadata; a read-only join would pass fixtures while finding no production data.

---

## Chapters

### 1. Work
*Agent: default*

- Stamp RELAY_ATTEST_SESSION_ID on every Relay message writer before joining by session_ref: Stamp RELAY_ATTEST_SESSION_ID on every Relay message writer before joining by session_ref
- The exact session_ref join now has both halves: all Relay message writers persist the current session id, and replay paginates Relaycast 8.0.7, merges by timestamp, and fails closed on missing or pruned coverage. Verification is green except one unrelated pre-existing broker-lifecycle assertion in the full suite.
