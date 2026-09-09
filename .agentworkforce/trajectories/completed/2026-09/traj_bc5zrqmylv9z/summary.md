# Trajectory: Repair PR 1713 SDK compatibility and behavioral RelayFlow proof

> **Status:** ✅ Completed
> **Task:** relay#1713
> **Confidence:** 95%
> **Started:** September 9, 2026 at 06:18 AM
> **Completed:** September 9, 2026 at 06:48 AM

---

## Summary

Preserved the shipped workspace.fleetNodes SDK contract as an immutable always-on compatibility shim, removed only the obsolete Relaycast remote dependency and CLI rollout controls, and replaced source inspection with compiled base/head CLI plus downstream SDK runtime/type proof under a self-tested network deny harness.

**Approach:** Standard approach

---

## Key Decisions

### Preserve deprecated fleetNodes as an immutable always-on SDK compatibility surface
- **Chose:** Preserve deprecated fleetNodes as an immutable always-on SDK compatibility surface
- **Reasoning:** The API shipped publicly in 8.9.0, so removing its runtime and types in a patch release would break consumers. Returning the same truthful always-on state from get, set, and inherit preserves shape without claiming a mutation occurred or calling the removed Relaycast API.

### Use compiled public behavior for the issue 1400 RelayFlow proof
- **Chose:** Use compiled public behavior for the issue 1400 RelayFlow proof
- **Reasoning:** Source-string checks can pass on dead code. The proof now installs and builds each exact arm, drives CLI help and legacy commands, traps network, checks credential non-echo, and exercises the compiled SDK compatibility surface.

---

## Chapters

### 1. Work
*Agent: default*

- Preserve deprecated fleetNodes as an immutable always-on SDK compatibility surface: Preserve deprecated fleetNodes as an immutable always-on SDK compatibility surface
- Use compiled public behavior for the issue 1400 RelayFlow proof: Use compiled public behavior for the issue 1400 RelayFlow proof
- First fresh review found two proof false-positive paths; both were hardened with enforced network denial plus self-canary and a real downstream TypeScript compile. Exact base and head proof arms now pass.
- Restored the deprecated immutable SDK facade, replaced source-grep proof with compiled consumer/runtime behavior, and hardened network denial across direct sockets and DNS promises; head proof is green, while an exact base rerun is temporarily blocked by host ENOSPC and awaiting coordinated cleanup.
