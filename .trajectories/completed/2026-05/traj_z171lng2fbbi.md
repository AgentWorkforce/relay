# Trajectory: Address PR 840 review feedback

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** May 11, 2026 at 10:06 AM
> **Completed:** May 11, 2026 at 10:07 AM

---

## Summary

Addressed PR 840 feedback by adding the cloud tarball to the negative optional-dep smoke install, adding cloud to the publish-sdk-internal-deps matrix, replacing the first trajectory projectId absolute path with AgentWorkforce/relay, and fixing wildcard text in the trajectory Markdown. Revalidated workflow YAML, trajectory JSON, and static internal-dependency coverage across pack, positive smoke, negative smoke, and publish matrix.

**Approach:** Standard approach

---

## Key Decisions

### Included cloud in all SDK publish dependency paths

- **Chose:** Included cloud in all SDK publish dependency paths
- **Reasoning:** Review feedback showed the negative smoke and SDK-only internal publish matrix must mirror the positive smoke path because @agent-relay/cloud is an exact-version runtime dependency of @agent-relay/sdk.

---

## Chapters

### 1. Work

_Agent: default_

- Included cloud in all SDK publish dependency paths: Included cloud in all SDK publish dependency paths
