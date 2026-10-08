# Trajectory: Finish Flows v2 path migration in PR 1811

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** September 19, 2026 at 06:13 PM
> **Completed:** September 19, 2026 at 06:14 PM

---

## Summary

Removed operational Relayflows v1 path references from the Flows v2 feature verifier, pointed integrity/autofix at flows/verify/features.spec.ts, and aligned PR-proof classification and tests with the v2 flows directory.

**Approach:** Updated runtime strings and the non-runtime path allowlist, then generated the v2 spec and ran 157 focused tests plus flows:check.

---

## Key Decisions

### Replace operational v1 path references with the v2 spec path
- **Chose:** Replace operational v1 path references with the v2 spec path
- **Rejected:** Leave v1 names as historical labels
- **Reasoning:** The v2 feature flow still directed autofix integrity counting and repair prompts at a deleted workflows/verify-features.ts file, which could make a real repair run count zero checks or edit the wrong target.

### Classify flows/ definitions as non-runtime
- **Chose:** Classify flows/ definitions as non-runtime
- **Rejected:** Keep only the legacy workflows/ exemption
- **Reasoning:** Flows v2 definitions are CI and scheduled orchestration sources, like the previously exempt workflows/ directory; they are not shipped CLI or broker runtime surfaces.

---

## Chapters

### 1. Work
*Agent: default*

- Replace operational v1 path references with the v2 spec path: Replace operational v1 path references with the v2 spec path
- Classify flows/ definitions as non-runtime: Classify flows/ definitions as non-runtime
