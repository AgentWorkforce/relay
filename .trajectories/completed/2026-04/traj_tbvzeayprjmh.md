# Trajectory: Align AgentRelaySpawnOptions.binaryArgs with Rust binary args type

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** April 2, 2026 at 11:48 AM
> **Completed:** April 2, 2026 at 11:52 AM

---

## Summary

Typed AgentRelaySpawnOptions.binaryArgs to the broker init flags, serialized them in AgentRelayClient.spawn, and updated internal callers/tests to use the structured shape.

**Approach:** Standard approach

---

## Key Decisions

### Model AgentRelaySpawnOptions.binaryArgs as typed broker init options instead of raw argv
- **Chose:** Model AgentRelaySpawnOptions.binaryArgs as typed broker init options instead of raw argv
- **Reasoning:** The Rust broker init command has a fixed structured surface (api_port, api_bind, persist, state_dir). Using a TS object keeps the SDK aligned with the broker contract and avoids invalid flags like --debug compiling.

---

## Chapters

### 1. Work
*Agent: default*

- Model AgentRelaySpawnOptions.binaryArgs as typed broker init options instead of raw argv: Model AgentRelaySpawnOptions.binaryArgs as typed broker init options instead of raw argv
