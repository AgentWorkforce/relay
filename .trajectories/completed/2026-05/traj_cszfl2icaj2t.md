# Trajectory: Add Prettier auto-format workflow

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 26, 2026 at 07:04 AM
> **Completed:** May 26, 2026 at 07:05 AM

---

## Summary

Added a Prettier auto-format workflow for same-repo PRs. The workflow runs npm ci, npm run format, commits changed files as github-actions[bot], and pushes them back to the PR branch.

**Approach:** Standard approach

---

## Key Decisions

### Added a same-repo PR Prettier auto-format workflow

- **Chose:** Added a same-repo PR Prettier auto-format workflow
- **Reasoning:** The existing Rust auto-format workflow only runs cargo fmt. The new workflow runs npm run format for Prettier-owned file types and pushes a bot commit when same-repo PR formatting changes are detected.

---

## Chapters

### 1. Work

_Agent: default_

- Added a same-repo PR Prettier auto-format workflow: Added a same-repo PR Prettier auto-format workflow
