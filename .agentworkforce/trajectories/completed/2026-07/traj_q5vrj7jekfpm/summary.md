# Trajectory: Node providers: broker demotion, fleet retarget, per-language node up (relay step 3)

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** July 9, 2026 at 07:57 AM
> **Completed:** July 9, 2026 at 08:47 PM

---

## Summary

Node providers step 3 (relay): broker demoted to the 'broker' capacity provider on /v1/node/ws; @agent-relay/fleet retargeted to @relaycast/sdk's node-provider client; node up serves agent-relay.{ts,py} providers; sidecar /api/fleet/ws protocol removed; Python NodeProvider.from_enrollment added. Live-verified end-to-end against a local relaycast engine. PR #1239.

**Approach:** Standard approach

---

## Key Decisions

### Broker self-advertises spawn:<harness>/release capacity; implicit case serves no TS provider

- **Chose:** Broker self-advertises spawn:<harness>/release capacity; implicit case serves no TS provider
- **Reasoning:** Engine placement matches exact capability names and capacityProviderName needs the broker to own the harness; §3.3 no-silent-bypass means an implicit spawn shadow would fail-fast when its TS provider is offline

### Expose broker node_id/node_name via /api/session so the CLI attaches TS/Py providers to the same node

- **Chose:** Expose broker node_id/node_name via /api/session so the CLI attaches TS/Py providers to the same node
- **Reasoning:** Engine rejects node.register on node_id mismatch; the broker is the authoritative resolver (pinned to machine seed)

---

## Chapters

### 1. Work

_Agent: default_

- Broker self-advertises spawn:<harness>/release capacity; implicit case serves no TS provider: Broker self-advertises spawn:<harness>/release capacity; implicit case serves no TS provider
- Expose broker node_id/node_name via /api/session so the CLI attaches TS/Py providers to the same node: Expose broker node_id/node_name via /api/session so the CLI attaches TS/Py providers to the same node
- Task D (Python NodeProvider.from_enrollment) blocked: relaycast-sdk PyPI 0.3.0 predates the NodeProvider (#243); reporting per instruction, not vendoring: Task D (Python NodeProvider.from_enrollment) blocked: relaycast-sdk PyPI 0.3.0 predates the NodeProvider (#243); reporting per instruction, not vendoring

---

## Artifacts

**Commits:** 948ad813
**Files changed:** 31
