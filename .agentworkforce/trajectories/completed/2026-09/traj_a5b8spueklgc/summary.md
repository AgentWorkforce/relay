# Trajectory: Resolve all active review and CI findings for Relay PR #1851

> **Status:** ❌ Abandoned
> **Task:** AgentWorkforce/relay#1851
> **Started:** September 25, 2026 at 01:22 AM
> **Completed:** September 30, 2026 at 04:43 PM

---

## Key Decisions

### Use one atomically published receipt file per delivery ID
- **Chose:** Use one atomically published receipt file per delivery ID
- **Reasoning:** Removes the fixed-capacity outage and whole-ledger rewrites while preserving indefinite idempotency without unsafe pruning

### Persist deferred native messages with explicit queued, in-doubt, and accepted states
- **Chose:** Persist deferred native messages with explicit queued, in-doubt, and accepted states
- **Reasoning:** Restarts can recover queued messages, never replay an ambiguous injection, and safely discard a message already accepted before queue cleanup

### Classify a dropped runtime reply by consulting the durable receipt outside the Tokio event loop
- **Chose:** Classify a dropped runtime reply by consulting the durable receipt outside the Tokio event loop
- **Rejected:** Always claim committed=true, Always claim committed=false
- **Reasoning:** The oneshot can close both before and after reservation. An exact receipt distinguishes safely retryable uncommitted delivery from queued or in-doubt delivery without weakening fail-closed semantics.

### Require stable native sidecar session and runtime roots and place launch state under the Agent Relay user data directory
- **Chose:** Require stable native sidecar session and runtime roots and place launch state under the Agent Relay user data directory
- **Rejected:** Keep the OS temp default with a suppression, Use a random root that loses restart discovery
- **Reasoning:** Deferred receipts must survive restart, and a predictable shared OS-temp root permits path attacks. The stable user data root preserves durability while removing the CodeQL temp-path flow.

### Report post-publish receipt directory sync failures as in-doubt
- **Chose:** Report post-publish receipt directory sync failures as in-doubt
- **Rejected:** Return ReceiptUnavailable after publish, Ignore directory fsync failures
- **Reasoning:** persist_noclobber has already made the reservation visible, so committed=false would invite a retry that can conflict with at-most-once semantics. Strict fsync remains required, but failure is classified conservatively.

### Pin @relayflows/sdk optional peers via npm overrides during publish version bump
- **Chose:** Pin @relayflows/sdk optional peers via npm overrides during publish version bump
- **Reasoning:** Publish major to 13.0.0 failed ERESOLVE because @relayflows/sdk@2.0.36 peerOptional caps @agent-relay/sdk at <13. Override forces workspace versions so clean reinstall after bump succeeds without waiting on a flows peer-range release.

---

## Chapters

### 1. Work
*Agent: default*

- Use one atomically published receipt file per delivery ID: Use one atomically published receipt file per delivery ID
- Persist deferred native messages with explicit queued, in-doubt, and accepted states: Persist deferred native messages with explicit queued, in-doubt, and accepted states
- Classify a dropped runtime reply by consulting the durable receipt outside the Tokio event loop: Classify a dropped runtime reply by consulting the durable receipt outside the Tokio event loop
- Require stable native sidecar session and runtime roots and place launch state under the Agent Relay user data directory: Require stable native sidecar session and runtime roots and place launch state under the Agent Relay user data directory
- Report post-publish receipt directory sync failures as in-doubt: Report post-publish receipt directory sync failures as in-doubt
- Pin @relayflows/sdk optional peers via npm overrides during publish version bump: Pin @relayflows/sdk optional peers via npm overrides during publish version bump
- Abandoned: Stale trajectory from prior PR #1851 work; starting fresh for publish peer fix
