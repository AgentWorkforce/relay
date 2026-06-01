# Trajectory: Rename packages/driver to packages/runtime and create packages/harnesses

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** May 28, 2026 at 04:26 PM
> **Completed:** May 28, 2026 at 04:30 PM

---

## Summary

Renamed packages/driver to packages/runtime (all imports updated), created packages/harnesses with 8 CLI harness exports

**Approach:** Standard approach

---

## Key Decisions

### Renamed @agent-relay/driver to @agent-relay/runtime

- **Chose:** Renamed @agent-relay/driver to @agent-relay/runtime
- **Reasoning:** Package rename requested: directory moved, all imports updated across packages/openclaw, packages/cli, packages/hooks, packages/gateway, and the package itself

### Created packages/harnesses with StaticPtyHarnessDefinition exports for all 8 supported CLIs

- **Chose:** Created packages/harnesses with StaticPtyHarnessDefinition exports for all 8 supported CLIs
- **Reasoning:** New thin package requested as a catalog of pre-built harness definitions

---

## Chapters

### 1. Work

_Agent: default_

- Renamed @agent-relay/driver to @agent-relay/runtime: Renamed @agent-relay/driver to @agent-relay/runtime
- Created packages/harnesses with StaticPtyHarnessDefinition exports for all 8 supported CLIs: Created packages/harnesses with StaticPtyHarnessDefinition exports for all 8 supported CLIs
