# Trajectory: Accept Relaycast context.update node frames in the broker (relay#1615)

> **Status:** ✅ Completed
> **Task:** 1615
> **Confidence:** 85%
> **Started:** September 2, 2026 at 04:39 AM
> **Completed:** September 2, 2026 at 04:42 AM

---

## Summary

Broker parses Relaycast context.update node frames, surfaces delivery.failed/deferred to the sending worker as message_delivery_failed, and drops the cached registration on agent.identity_taken_over

**Approach:** Standard approach

---

## Key Decisions

### Reused BrokerEvent::MessageDeliveryFailed for Relaycast delivery.failed/deferred instead of a new event kind
- **Chose:** Reused BrokerEvent::MessageDeliveryFailed for Relaycast delivery.failed/deferred instead of a new event kind
- **Reasoning:** SDK/dashboard consumers already render message_delivery_failed; a new kind would need client changes to be visible, defeating the point of surfacing the failure to the sending agent

### Reused RelaycastHttpClient::forget_agent_registration for agent.identity_taken_over
- **Chose:** Reused RelaycastHttpClient::forget_agent_registration for agent.identity_taken_over
- **Reasoning:** That cache is the state the takeover/registration paths in relaycast/ws.rs already consult; a parallel stale flag would drift

---

## Chapters

### 1. Work
*Agent: default*

- Reused BrokerEvent::MessageDeliveryFailed for Relaycast delivery.failed/deferred instead of a new event kind: Reused BrokerEvent::MessageDeliveryFailed for Relaycast delivery.failed/deferred instead of a new event kind
- Reused RelaycastHttpClient::forget_agent_registration for agent.identity_taken_over: Reused RelaycastHttpClient::forget_agent_registration for agent.identity_taken_over
