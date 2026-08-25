# Trajectory: Fix npm publish readiness race for SDK and root package

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 25, 2026 at 08:55 PM
> **Completed:** August 25, 2026 at 09:05 PM

---

## Summary

Confirmed npm's asynchronous SDK processing exposed a publish-readiness race, gated each npm package job on exact-version metadata and tarball availability with a 30-minute bound, added unit coverage and a Cloud red/green RelayFlow case, and recovered the partial 11.8.4 release by rerunning failed jobs.

**Approach:** Standard approach

---

## Key Decisions

### Gate each npm publish job on exact-version metadata and tarball readiness
- **Chose:** Gate each npm publish job on exact-version metadata and tarball readiness
- **Reasoning:** npm accepted @agent-relay/sdk@11.8.4 at 18:45:52 but did not expose it until 19:01:05; waiting at the producer preserves dependency ordering for every downstream job and a 30-minute bound covers the observed 15-minute processing delay.

---

## Chapters

### 1. Work
*Agent: default*

- Gate each npm publish job on exact-version metadata and tarball readiness: Gate each npm publish job on exact-version metadata and tarball readiness
