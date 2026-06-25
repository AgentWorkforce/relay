# Trajectory: Increment 2: broker node-only delivery — enroll as node, bind agents, deliver/inject over /v1/node/ws

> **Status:** ✅ Completed
> **Confidence:** 75%
> **Started:** June 25, 2026 at 02:25 PM
> **Completed:** June 25, 2026 at 02:41 PM

---

## Summary

Increment 2: broker enrolls as relaycast node (mint+persist node token via create_node, unconditional node.register at startup), binds every spawned agent via node-control agent.register (both /api/spawn and action.invoke spawn converge on register_node_agent_token), and delivers/injects over /v1/node/ws (real delivery_id, payload-type branching: message classes inject, reactions/receipts ack+log). action.invoke routes spawn/release to the Inc1 fns; fleet_mode suppresses firehose delivery once node delivery is live.

**Approach:** Standard approach

---

## Key Decisions

### Send node.register at startup via a broker self-manifest pushed as FleetControlCommand::RegisterNode right after spawning the node-control client
- **Chose:** Send node.register at startup via a broker self-manifest pushed as FleetControlCommand::RegisterNode right after spawning the node-control client
- **Reasoning:** RegisterNode is the only command that sets registration=Some and triggers connect; pushing it unconditionally from init makes the broker enroll regardless of any sidecar

### fleet_mode_enabled flips on FleetControlEvent::Connected and is never cleared on Disconnected
- **Chose:** fleet_mode_enabled flips on FleetControlEvent::Connected and is never cleared on Disconnected
- **Reasoning:** Connected is the precise signal node delivery is live; suppressing firehose delivery avoids double-delivery. Not clearing on disconnect honors at-least-once resume (engine holds + resumes from ack cursor), preventing double-injection during reconnect

### action.invoke spawn/release converge on the same node-binding helper as /api/spawn via register_node_agent_token
- **Chose:** action.invoke spawn/release converge on the same node-binding helper as /api/spawn via register_node_agent_token
- **Reasoning:** Step 3 requires both spawn paths to register via node-control; extracted a free fn both call sites share, with HTTP fallback when node binding is unavailable

---

## Chapters

### 1. Work
*Agent: default*

- Send node.register at startup via a broker self-manifest pushed as FleetControlCommand::RegisterNode right after spawning the node-control client: Send node.register at startup via a broker self-manifest pushed as FleetControlCommand::RegisterNode right after spawning the node-control client
- fleet_mode_enabled flips on FleetControlEvent::Connected and is never cleared on Disconnected: fleet_mode_enabled flips on FleetControlEvent::Connected and is never cleared on Disconnected
- action.invoke spawn/release converge on the same node-binding helper as /api/spawn via register_node_agent_token: action.invoke spawn/release converge on the same node-binding helper as /api/spawn via register_node_agent_token
