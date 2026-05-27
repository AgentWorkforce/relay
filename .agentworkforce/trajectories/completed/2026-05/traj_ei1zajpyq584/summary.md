# Trajectory: Rename SDK spawn provider terminology

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 27, 2026 at 08:49 AM
> **Completed:** May 27, 2026 at 08:57 AM

---

## Summary

Renamed the SDK spawn API from provider terminology to CLI terminology for the major release: AgentRelayClient.spawnProvider -> spawnCli, SpawnProviderInput -> SpawnCliInput, SpawnHeadlessInput.provider -> cli, lifecycle kind provider -> cli/headless, with docs, changelog migration notes, gateway type update, and tests.

**Approach:** Standard approach

---

## Key Decisions

### Rename SDK provider spawn vocabulary to cli/headless
- **Chose:** Rename SDK provider spawn vocabulary to cli/headless
- **Reasoning:** The broker payload already uses cli, and provider is stale terminology now that harness configs represent the execution harness. Because this is a major release, the SDK can remove the legacy SpawnProviderInput/spawnProvider surface instead of layering aliases.

---

## Chapters

### 1. Work
*Agent: default*

- Rename SDK provider spawn vocabulary to cli/headless: Rename SDK provider spawn vocabulary to cli/headless
