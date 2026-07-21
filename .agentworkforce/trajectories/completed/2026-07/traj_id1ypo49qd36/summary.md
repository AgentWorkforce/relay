# Trajectory: Make AI SDK observability the benchmark for all Relay runtimes

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** July 15, 2026 at 09:44 PM
> **Completed:** July 15, 2026 at 09:47 PM

---

## Summary

Extended the adoption plan with a canonical Relay observability contract, Relaycast activity events, capability/fidelity profiles, and PTY parity reporting against AI SDK.

**Approach:** Standard approach

---

## Key Decisions

### Use AI SDK HarnessV1 as Relay's reference observability profile

- **Chose:** Use AI SDK HarnessV1 as Relay's reference observability profile
- **Reasoning:** HarnessV1 has the richest portable structured stream across supported runtimes. Relaycast will expose a runtime-neutral semantic vocabulary and activity reducer, while each runtime declares exact, inferred, and unavailable signals with provenance. PTY implementations improve against the same profile.

---

## Chapters

### 1. Work

_Agent: default_

- Use AI SDK HarnessV1 as Relay's reference observability profile: Use AI SDK HarnessV1 as Relay's reference observability profile
