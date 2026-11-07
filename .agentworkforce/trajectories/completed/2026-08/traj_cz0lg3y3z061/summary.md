# Trajectory: Extend Cloud fleet sandbox client budget beyond mounted provisioning deadline

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 24, 2026 at 10:42 PM
> **Completed:** August 24, 2026 at 10:53 PM

---

## Summary

Extended only the Cloud fleet sandbox provisioning request to a bounded 480-second budget, retained 120-second workspace resolution, added a regression with mutation proof, updated the patch changelog, and passed package, CLI, build, format, and diff gates.

**Approach:** Standard approach

---

## Key Decisions

### Keep workspace resolution at 120 seconds and extend only mounted provisioning to 480 seconds
- **Chose:** Keep workspace resolution at 120 seconds and extend only mounted provisioning to 480 seconds
- **Reasoning:** Production provisioning can legitimately spend 240 seconds on initial Relayfile sync plus 90 seconds on roster readiness; a bounded 480-second request budget preserves sandbox identity for cleanup without weakening the cheaper resolution bound.

---

## Chapters

### 1. Work
*Agent: default*

- Keep workspace resolution at 120 seconds and extend only mounted provisioning to 480 seconds: Keep workspace resolution at 120 seconds and extend only mounted provisioning to 480 seconds
