# Trajectory: Publish fleet and attach subpaths and forward sandbox readonlyPaths

> **Status:** ❌ Abandoned
> **Started:** September 18, 2026 at 03:11 PM
> **Completed:** September 18, 2026 at 03:21 PM

---

## Key Decisions

### Implement shared attach transport in Cloud with SDK re-exports; preserve ESM exports and inferred completion semantics
- **Chose:** Implement shared attach transport in Cloud with SDK re-exports; preserve ESM exports and inferred completion semantics
- **Reasoning:** Reviewed plan identifies Cloud as the consumer import target, no remote exit-code protocol, and no server mount handler in this repository. D4 running-agent orchestration remains pending user scope clarification.

---

## Chapters

### 1. Work
*Agent: default*

- Implement shared attach transport in Cloud with SDK re-exports; preserve ESM exports and inferred completion semantics: Implement shared attach transport in Cloud with SDK re-exports; preserve ESM exports and inferred completion semantics
- Abandoned: Attach extraction and readonlyPaths client implementation ready; full spawnFleetSandbox orchestration awaits reviewed-plan.md D4 scope decision. Server chmod enforcement is outside this repository.
