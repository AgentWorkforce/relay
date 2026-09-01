# Trajectory: Audit and address PR 1632 exact-broker artifact bridge feedback

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 95%
> **Started:** September 1, 2026 at 08:38 PM
> **Completed:** September 1, 2026 at 08:49 PM

---

## Summary

Hardened PR 1632's broker artifact bridge: trusted pull_request_target and every-main-SHA producers, exact SHA/path/event validation, bounded artifact polling, and contract coverage for accepted and rejected provenance.

**Approach:** Standard approach

---

## Key Decisions

### Require exact workflow-run SHA and continuous base artifact coverage
- **Chose:** Require exact workflow-run SHA and continuous base artifact coverage
- **Reasoning:** Artifact names and self-authored manifests alone do not bind a successful producer run to the requested source SHA. Also, path-filtering main pushes leaves no artifact for an unrelated new base commit. The resolver now checks run.head_sha, main produces every exact base, and any changed RelayFlow case produces its exact head broker.

### Trust only default-branch broker producers and poll for completion
- **Chose:** Trust only default-branch broker producers and poll for completion
- **Reasoning:** Use a pull_request_target workflow with contents:read, no persisted checkout credentials, and no secrets so workflow logic comes from the trusted default branch while building the requested PR SHA. Resolve only successful exact-path runs whose head SHA equals the request and whose event is pull_request_target or a main-branch push; bounded polling closes the dispatcher/build race without accepting pull_request or workflow_dispatch artifacts.

---

## Chapters

### 1. Work
*Agent: default*

- Require exact workflow-run SHA and continuous base artifact coverage: Require exact workflow-run SHA and continuous base artifact coverage
- Trust only default-branch broker producers and poll for completion: Trust only default-branch broker producers and poll for completion
