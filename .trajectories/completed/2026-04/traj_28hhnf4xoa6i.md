# Trajectory: Harden macOS binary release verification

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** April 10, 2026 at 01:22 PM
> **Completed:** April 10, 2026 at 01:29 PM

---

## Summary

Added macOS Bun binary signing and verification hardening for release artifacts. New helper scripts strip malformed signatures before ad-hoc signing and verify Mach-O arch plus codesign before optional smoke execution. Publish/package-validation/test-build/OpenClaw workflows now use the checks; installer and npm postinstall can repair malformed signatures by removing them first. Also cleaned stale active trajectories so trail recording works.

**Approach:** Standard approach

---

## Key Decisions

### Quarantine malformed active trajectory records and abandon stale PR 691 trajectory

- **Chose:** Quarantine malformed active trajectory records and abandon stale PR 691 trajectory
- **Reasoning:** The current trail CLI refused to start a new trajectory while malformed workflow-runner records and an unrelated active PR 691 record remained in .trajectories/active. Moving malformed records preserves evidence without blocking status/start; abandoning the stale valid active record uses the CLI path and keeps history.

### Ad-hoc sign macOS Bun binaries after removing Bun's invalid embedded signature

- **Chose:** Ad-hoc sign macOS Bun binaries after removing Bun's invalid embedded signature
- **Reasoning:** The v4.0.9 darwin-arm64 Bun artifact had an LC_CODE_SIGNATURE that macOS reported as invalid or unsupported; codesign --force alone could not repair it. Reproduced that codesign --remove-signature followed by codesign --force --sign - makes the binary verify and execute.

### Verify both compressed and uncompressed macOS release artifacts in CI

- **Chose:** Verify both compressed and uncompressed macOS release artifacts in CI
- **Reasoning:** The installer tries .gz first and then uncompressed, so the publish gate needs to decompress and verify the exact same artifact shape. The macOS jobs now check arm64 and x64 signatures for agent-relay and relay-acp, and smoke-execute when compatible with the runner.

---

## Chapters

### 1. Work

_Agent: default_

- Quarantine malformed active trajectory records and abandon stale PR 691 trajectory: Quarantine malformed active trajectory records and abandon stale PR 691 trajectory
- Ad-hoc sign macOS Bun binaries after removing Bun's invalid embedded signature: Ad-hoc sign macOS Bun binaries after removing Bun's invalid embedded signature
- Implemented macOS binary hardening across release build, release verification, local build scripts, installer repair, and npm postinstall repair. Verification now checks code signatures before smoke execution and signs Bun Mach-O outputs before compression.
- Verify both compressed and uncompressed macOS release artifacts in CI: Verify both compressed and uncompressed macOS release artifacts in CI
