# Trajectory: Add bundled dependency audit CI check

> **Status:** ✅ Completed
> **Task:** PR-339
> **Confidence:** 95%
> **Started:** January 28, 2026 at 05:15 PM
> **Completed:** January 28, 2026 at 05:15 PM

---

## Summary

Added pre-merge CI check that audits bundled package dependencies. Hoisted 6 missing deps (zod, zod-to-json-schema, posthog-node, pg, smol-toml, @modelcontextprotocol/sdk) to root package.json.

**Approach:** Standard approach

---

## Key Decisions

### Added audit to package-validation.yml workflow
- **Chose:** Added audit to package-validation.yml workflow
- **Reasoning:** Already runs on PRs to main, no need for a separate workflow

---

## Chapters

### 1. Work
*Agent: default*

- Added audit to package-validation.yml workflow: Added audit to package-validation.yml workflow
