# Trajectory: Fix PR 949 CI failure

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** May 22, 2026 at 12:56 PM
> **Completed:** May 22, 2026 at 12:57 PM

---

## Summary

Fixed PR 949 CI by removing stale @agent-relay/user-directory references from package-validation import smoke tests and publish matrices. Verified no remaining package references outside trajectory notes, workflow formatting, diff whitespace, and the CI key-import smoke test.

**Approach:** Standard approach

---

## Key Decisions

### Remove stale CI and publish workflow references

- **Chose:** Remove stale CI and publish workflow references
- **Reasoning:** PR 949 deleted @agent-relay/user-directory, but package-validation still smoke-imported it and publish.yml still listed it in package matrices; keeping those references would make CI and release automation fail after the package removal.

---

## Chapters

### 1. Work

_Agent: default_

- Remove stale CI and publish workflow references: Remove stale CI and publish workflow references
