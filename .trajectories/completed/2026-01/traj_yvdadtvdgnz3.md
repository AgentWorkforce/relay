# Trajectory: Full cloud e2e flow review

> **Status:** ✅ Completed
> **Task:** cloud-review
> **Confidence:** 85%
> **Started:** January 3, 2026 at 07:17 PM
> **Completed:** January 3, 2026 at 07:22 PM

---

## Summary

Full cloud e2e flow review complete. Flow is viable for MVP with minor limitations: 100 repo max, multi-repo spawns to workspace root. Key pieces verified: Nango OAuth, GitHub App tokens, vault credentials, workspace provisioning, entrypoint cloning, credential file creation, spawn mechanism.

**Approach:** Standard approach

---

## Key Decisions

### Multi-repo spawning uses workspace root, not specific repo
- **Chose:** Multi-repo spawning uses workspace root, not specific repo
- **Reasoning:** When agents spawn, cwd is /workspace (where all repos live), not /workspace/repo-name. This is acceptable for MVP - tasks can specify which repo to work on, and agents can cd into the right directory.

### Repo sync limited to 100 repos
- **Chose:** Repo sync limited to 100 repos
- **Reasoning:** listGithubAppRepos only fetches first 100 repos from GitHub API. This is a known limitation - users with >100 repos won't see all of them. Acceptable for MVP, can add pagination later.

---

## Chapters

### 1. Work
*Agent: default*

- Multi-repo spawning uses workspace root, not specific repo: Multi-repo spawning uses workspace root, not specific repo
- Repo sync limited to 100 repos: Repo sync limited to 100 repos
