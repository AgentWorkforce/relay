# Trajectory: Fix CI in chore/remove-migrated-packages

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** May 29, 2026 at 06:35 AM
> **Completed:** May 29, 2026 at 06:43 AM

---

## Summary

Fixed Package Validation publish-fresh OOM by pinning root Zod to v3 so fresh npm installs keep zod-to-json-schema type-checking against the same major as @agent-relay/config.

**Approach:** Standard approach

---

## Key Decisions

### Pinned root Zod to v3 for publish-resolution installs

- **Chose:** Keep zod-to-json-schema on Zod 3 during fresh npm installs
- **Reasoning:** The OOM reproduced only after deleting package-lock.json: npm resolved root zod to v4, so zod-to-json-schema type-checked against Zod 4 while @agent-relay/config schemas use Zod 3. A root Zod v3 devDependency keeps that peer resolution aligned with the lockfile while nested Zod 4 consumers retain their own copy.

---

## Chapters

### 1. Work

_Agent: default_

- Pinned root Zod to v3 for publish-resolution installs: Keep zod-to-json-schema on Zod 3 during fresh npm installs
