# Trajectory: Fix npx --version test failure in verify-publish

> **Status:** ✅ Completed
> **Task:** agent-relay-540
> **Confidence:** 90%
> **Started:** January 28, 2026 at 09:21 AM
> **Completed:** January 28, 2026 at 09:21 AM

---

## Summary

Fixed npx --version test failing on Node 20/22 due to bash expansion edge case. Changed to explicit variable capture and empty check with normalization to 'latest'. Added guard + debug output for future troubleshooting. Commit: 3791cb29

**Approach:** Standard approach

---

## Key Decisions

### Diagnosed bash expansion edge case in workflow variable handling
- **Chose:** Diagnosed bash expansion edge case in workflow variable handling
- **Reasoning:** GitHub Actions doesn't evaluate || operator for unset variables. '${{ inputs.version || latest }}' resolves to empty string instead of 'latest' when inputs.version is unset on PR runs, causing SPEC=agent-relay@ which npx fails to parse

### Implemented explicit empty check and normalization in bash script
- **Chose:** Implemented explicit empty check and normalization in bash script
- **Reasoning:** Use explicit '${{ inputs.version }}' into VERSION_INPUT variable, then bash script checks 'if [ -z VERSION_INPUT ]' and normalizes to 'latest'. Added guard clause with debug output to fail fast and print resolved spec for future debugging

---

## Chapters

### 1. Work
*Agent: default*

- Diagnosed bash expansion edge case in workflow variable handling: Diagnosed bash expansion edge case in workflow variable handling
- Implemented explicit empty check and normalization in bash script: Implemented explicit empty check and normalization in bash script
