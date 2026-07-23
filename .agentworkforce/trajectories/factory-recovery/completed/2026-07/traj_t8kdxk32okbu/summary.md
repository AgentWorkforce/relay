# Trajectory: Unify project-aware Relay workspace key resolution for Factory and CLI

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** July 20, 2026 at 09:26 PM
> **Completed:** July 20, 2026 at 09:36 PM

---

## Summary

Added and verified a public project-aware workspace-key resolver, migrated the CLI to it, retained compatibility re-exports, documented the patch, and validated 1300 tests plus typecheck, formatting, core build, and package contents.

**Approach:** Moved the existing secure project-key persistence into the cloud package, encoded resolution precedence in one public API, exposed a side-effect-minimal subpath, and regression-tested every source and malformed-state fallback.

---

## Key Decisions

### Made project-aware workspace resolution a public @agent-relay/cloud contract

- **Chose:** Made project-aware workspace resolution a public @agent-relay/cloud contract
- **Reasoning:** Factory and other SDK consumers must use the same explicit/env/project/global precedence as the CLI; centralizing the existing project workspace-key store prevents cross-workspace agent_not_found failures.

---

## Chapters

### 1. Work

_Agent: default_

- Made project-aware workspace resolution a public @agent-relay/cloud contract: Made project-aware workspace resolution a public @agent-relay/cloud contract
- Centralized workspace resolution in @agent-relay/cloud with explicit flag and environment precedence, then the project broker key before the global active store. A dedicated workspace-key package subpath avoids cloud barrel side effects and works in source tests and packed output.
