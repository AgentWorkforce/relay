# Trajectory: Implement Agent Relay core simplification

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** May 27, 2026 at 12:39 PM
> **Completed:** May 27, 2026 at 01:29 PM

---

## Summary

Implemented Agent Relay core simplification: SDK messaging/delivery/actions, optional driver package, MCP action tools, pruned CLI and legacy SDK surfaces, updated docs and verification.

**Approach:** Standard approach

---

## Key Decisions

### Create @agent-relay/driver as managed harness boundary
- **Chose:** Create @agent-relay/driver as managed harness boundary
- **Reasoning:** The current Rust broker/client code owns harness lifecycle and injection, which is driver infrastructure rather than Agent Relay core messaging. Keeping a separate in-repo package preserves local broker coupling while removing spawn as a root SDK concept.

### Document core as Relaycast-backed SDK plus optional driver harness
- **Chose:** Document core as Relaycast-backed SDK plus optional driver harness
- **Reasoning:** Worker C owns docs only; the docs should describe Agent Relay as the product, keep Relaycast as the transport layer, and put broker/harness orchestration behind @agent-relay/driver for the SemVer-major split.

### Scoped messaging surface to packages/sdk/src/messaging with relative tests
- **Chose:** Scoped messaging surface to packages/sdk/src/messaging with relative tests
- **Reasoning:** The user asked Worker A to own only SDK messaging core files and avoid package export/package metadata/doc changes unless necessary; tests can import the new surface by source path while package exports are handled separately.

### Merged SDK action validation into concurrent messaging contracts
- **Chose:** Merged SDK action validation into concurrent messaging contracts
- **Reasoning:** A concurrent worker added RelayMessaging, AgentDeliveryAdapter, and InMemoryAgentRelayActions contracts while this worker was implementing delivery/actions. I preserved those public shapes and added schema-lite validation, registry helpers, and capability-gated DeliveryRunner tests around them instead of replacing the concurrent work.

### Implemented Relaycast-backed SDK messaging core
- **Chose:** Implemented Relaycast-backed SDK messaging core
- **Reasoning:** Added normalized Agent Relay messaging types, Relaycast adapters, event/inbox normalization, and explicit unsupported durable delivery capabilities under packages/sdk/src/messaging without changing package metadata or docs in this slice.

---

## Chapters

### 1. Work
*Agent: default*

- Create @agent-relay/driver as managed harness boundary: Create @agent-relay/driver as managed harness boundary
- Document core as Relaycast-backed SDK plus optional driver harness: Document core as Relaycast-backed SDK plus optional driver harness
- Scoped messaging surface to packages/sdk/src/messaging with relative tests: Scoped messaging surface to packages/sdk/src/messaging with relative tests
- Worker C docs pass is complete: root README, SDK README, scope artifact, and changelog now describe Agent Relay as product, Relaycast as transport, SDK core communication, and @agent-relay/driver as optional harness layer.
- Merged SDK action validation into concurrent messaging contracts: Merged SDK action validation into concurrent messaging contracts
- Implemented Relaycast-backed SDK messaging core: Implemented Relaycast-backed SDK messaging core
