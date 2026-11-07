# Trajectory: Implement relay issue #1507 join-ticket attach redemption

> **Status:** ✅ Completed
> **Task:** [1507](https://github.com/AgentWorkforce/relay/issues/1507)
> **Confidence:** 92%
> **Started:** August 14, 2026 at 03:06 PM
> **Completed:** August 14, 2026 at 03:10 PM

---

## Summary

Implemented relay #1507: node agent attach redeems cloud-issued, scope-bound workspace join tickets, persists the returned credential in the owner-only project pin, explicitly uses it for the current fleet attach, redacts the new ticket prefix, and reports invalid or expired tickets without falling through to workspace resolution.

**Approach:** Matched relaycast-cloud #61's concrete HTTP contract, reused the existing workspace-session persistence path, kept the one-time ticket out of persistence and logs, and added contract, dispatch, precedence, error, persistence, and redaction tests.

---

## Key Decisions

### Match the relaycast-cloud #61 redemption contract and pass the redeemed key explicitly to attach

- **Chose:** Match the relaycast-cloud #61 redemption contract and pass the redeemed key explicitly to attach
- **Reasoning:** The cloud branch defines POST /v1/workspace/join-tickets/redeem with an rjt*live* ticket scoped to node, agent, and mode. Persisting its workspace key makes later commands work, while explicitly passing it into the current attach prevents a higher-precedence ambient env key from winning.

---

## Chapters

### 1. Initial work

_Agent: ar-1507-impl-relay_

- Match the relaycast-cloud #61 redemption contract and pass the redeemed key explicitly to attach: Match the relaycast-cloud #61 redemption contract and pass the redeemed key explicitly to attach
- Cloud #61 defined a scope-bound rjt_live contract; the CLI now redeems, validates, persists, redacts, and uses the credential explicitly. Focused, full CLI, cloud, typecheck, and lint validation are green.

---

## Artifacts

**Commits:** c789886e4
**Files changed:** 12
