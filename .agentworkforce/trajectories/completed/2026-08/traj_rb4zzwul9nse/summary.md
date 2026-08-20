# Trajectory: Fix relay#1585 fleet agent list remote names and node filtering

> **Status:** ✅ Completed
> **Task:** relay#1585
> **Confidence:** 96%
> **Started:** August 20, 2026 at 12:27 PM
> **Completed:** August 20, 2026 at 01:58 PM

---

## Summary

Fixed relay#1585 by publishing exact broker live WorkerNames in the existing node heartbeat, decoding them for remote fleet agent output, enforcing strict targeted filtering without roster reads, and labeling all unavailable or inconsistent states degraded. Proved the mechanism on a disposable real sf-mini broker/PTY and hardened unit plus two-node E2E coverage.

**Approach:** Standard approach

---

## Key Decisions

### Use Relaycast node-agent bindings as the remote-name source
- **Chose:** Use Relaycast node-agent bindings as the remote-name source
- **Reasoning:** Brokers already publish inventory.sync on connect, inventory change, and every 60s; Relaycast exposes active bindings through nodes.listAgents(name). Relay currently omits this facade method and therefore degrades every remote node to count-only. The workspace roster is neither necessary nor trustworthy for liveness.

### Use the existing authenticated terminal tunnel for a node-local live inventory snapshot
- **Chose:** Use the existing authenticated terminal tunnel for a node-local live inventory snapshot
- **Reasoning:** Live proof falsified node-agent bindings: sf-mini has 231 historical bindings and one of four current PTYs is absent because provider identity reconciliation depends on overloaded D1. A reserved read-only terminal session can carry workers.list directly from the broker through the already-authenticated node tunnel, requiring neither SSH, a public broker port, registry reads, nor an engine API change.

### Publish live worker names in reserved heartbeat capabilities
- **Chose:** Publish live worker names in reserved heartbeat capabilities
- **Reasoning:** A real temporary sf-mini broker proved Relaycast terminal session creation pre-validates an active agent binding, so the terminal tunnel cannot bootstrap node inventory independently. Heartbeats already carry node capabilities and activeAgents; encoding the broker-owned WorkerName set there adds no request, registry read, or provider registration dependency, and nodes.list already returns the data.

### Extended the existing real two-node E2E capability contract for relay:live-agents:v1
- **Chose:** Extended the existing real two-node E2E capability contract for relay:live-agents:v1
- **Reasoning:** Fleet E2E correctly caught the new heartbeat capability as an unacknowledged protocol surface; asserting metadata.names is initially empty turns the repair into end-to-end coverage rather than merely loosening the expected array

---

## Chapters

### 1. Work
*Agent: default*

- Use Relaycast node-agent bindings as the remote-name source: Use Relaycast node-agent bindings as the remote-name source
- Use the existing authenticated terminal tunnel for a node-local live inventory snapshot: Use the existing authenticated terminal tunnel for a node-local live inventory snapshot
- Publish live worker names in reserved heartbeat capabilities: Publish live worker names in reserved heartbeat capabilities
- Mechanism investigation falsified both the workspace roster and existing node-agent bindings as live truth. A reserved live-name capability on the normal broker heartbeat proved exact against sf-mini OS PTYs through spawn and release, while count/name transition skew was rendered explicitly degraded.
- Extended the existing real two-node E2E capability contract for relay:live-agents:v1: Extended the existing real two-node E2E capability contract for relay:live-agents:v1

---

## Artifacts

**Commits:** eabfba00f, 462325e5f
**Files changed:** 13
