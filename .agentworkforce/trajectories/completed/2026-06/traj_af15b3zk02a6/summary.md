# Trajectory: Apply adversarial review correctness fixes to broker node-only delivery (v5.0.1)

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** June 25, 2026 at 03:29 PM
> **Completed:** June 25, 2026 at 03:39 PM

---

## Summary

Applied 6 adversarial-review correctness fixes to broker node-only delivery: HTTP-register fallback now binds agent to node + loud warnings; seq:0 fan-out frames surfaced/acked (action results inject, reactions/read ack-only); removed deny_unknown_fields from inbound Deliver/ActionInvoke; bounded seen_msg_ids (FIFO 512); faithful release action.result. Build+tests green (772 unit).

**Approach:** Standard approach

---

## Key Decisions

### Route action.completed/action.failed/action.denied (seq-0 fan-out) to Inject; keep message.reacted/read ack-only

- **Chose:** Route action.completed/action.failed/action.denied (seq-0 fan-out) to Inject; keep message.reacted/read ack-only
- **Reasoning:** Engine invocationCompletion.ts emits action.completed/action.failed to caller_id; routes/action.ts emits action.denied; all seq:0 via sendNodeDeliveriesToAgents

---

## Chapters

### 1. Work

_Agent: default_

- Route action.completed/action.failed/action.denied (seq-0 fan-out) to Inject; keep message.reacted/read ack-only: Route action.completed/action.failed/action.denied (seq-0 fan-out) to Inject; keep message.reacted/read ack-only
