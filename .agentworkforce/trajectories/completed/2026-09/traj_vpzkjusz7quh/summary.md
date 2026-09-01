# Trajectory: Address PR 1632 artifact lifetime feedback

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 96%
> **Started:** September 1, 2026 at 08:58 PM
> **Completed:** September 1, 2026 at 08:59 PM

---

## Summary

Extended trusted broker artifact retention/rebuild coverage, added a weekly exact-main refresh with strict resolver provenance tests, and preserved exact pull_request_target run head-SHA binding based on live Actions API evidence.

**Approach:** Standard approach

---

## Key Decisions

### Refresh exact artifacts only through trusted lifecycle events
- **Chose:** Refresh exact artifacts only through trusted lifecycle events
- **Reasoning:** Retain artifacts for 90 days, rebuild PR heads on the same trusted edited and ready-for-review events as the dispatcher, and schedule a weekly current-main build for repositories with no recent pushes. Scheduled artifacts remain acceptable only when the Actions run is successful, exact-SHA, exact-path, and reports head_branch main; workflow_dispatch remains rejected.

### Keep exact pull_request_target run head-SHA binding
- **Chose:** Keep exact pull_request_target run head-SHA binding
- **Reasoning:** GitHub Actions REST run 33546658507 directly reports head_sha d5ceea85ac339b79a9c3b664581eabdac5e9c7c7 and the associated PR object separately reports base SHA 3e4ab43002c55cb5b9e149d691aa7d4ce43d9ca5. This live API evidence supports exact run.head_sha validation despite GITHUB_SHA context semantics.

---

## Chapters

### 1. Work
*Agent: default*

- Refresh exact artifacts only through trusted lifecycle events: Refresh exact artifacts only through trusted lifecycle events
- Keep exact pull_request_target run head-SHA binding: Keep exact pull_request_target run head-SHA binding
