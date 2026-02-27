# Trajectory: Fix SDK publish to include freshly built broker binary

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 27, 2026 at 08:26 PM
> **Completed:** February 27, 2026 at 08:26 PM

---

## Summary

Fixed publish-sdk-only CI job to download freshly built broker binaries from build-broker artifacts into packages/sdk/bin/. Removed stale 13MB binary from git tracking and updated .gitignore.

**Approach:** Standard approach

---

## Key Decisions

### publish-sdk-only job was missing broker binary download
- **Chose:** publish-sdk-only job was missing broker binary download
- **Reasoning:** The job only depended on 'build' (TS compilation) and used --ignore-scripts which skipped prepack/bundle:binary. It shipped whatever stale binary was checked into packages/sdk/bin/ instead of the freshly compiled one from the build-broker CI job.

### Removed 13MB broker binary from git tracking
- **Chose:** Removed 13MB broker binary from git tracking
- **Reasoning:** Binary is built fresh by CI during every publish (build-broker job). Local dev resolves to target/release/ via client.ts resolveDefaultBinaryPath(). No reason to bloat the repo with a stale binary.

### Updated .gitignore from stale packages/broker-sdk/bin/ to packages/sdk/bin/agent-relay-broker*
- **Chose:** Updated .gitignore from stale packages/broker-sdk/bin/ to packages/sdk/bin/agent-relay-broker*
- **Reasoning:** The old entry referenced a renamed package. Updated to match the current SDK path and prevent the binary from being re-committed.

---

## Chapters

### 1. Work
*Agent: default*

- publish-sdk-only job was missing broker binary download: publish-sdk-only job was missing broker binary download
- Removed 13MB broker binary from git tracking: Removed 13MB broker binary from git tracking
- Updated .gitignore from stale packages/broker-sdk/bin/ to packages/sdk/bin/agent-relay-broker*: Updated .gitignore from stale packages/broker-sdk/bin/ to packages/sdk/bin/agent-relay-broker*
