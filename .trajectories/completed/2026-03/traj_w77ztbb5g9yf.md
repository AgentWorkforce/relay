# Trajectory: Investigate failing agent-relay up command

> **Status:** ✅ Completed
> **Confidence:** 87%
> **Started:** March 10, 2026 at 02:26 PM
> **Completed:** March 10, 2026 at 02:43 PM

---

## Summary

Fixed the duplicate CLI entrypoint execution that caused agent-relay commands to run twice, added macOS broker re-signing in install.sh, and added regression coverage plus local/manual validation for the broken up/status/down paths.

**Approach:** Standard approach

---

## Key Decisions

### Make src/cli/index.ts the sole executable CLI entrypoint and remove bootstrap auto-run
- **Chose:** Make src/cli/index.ts the sole executable CLI entrypoint and remove bootstrap auto-run
- **Reasoning:** The standalone bundled CLI was executing commands twice because both bootstrap and index had entrypoint side effects, which caused duplicate broker starts and false already-running errors.

### Re-sign downloaded macOS binaries in install.sh before verification
- **Chose:** Re-sign downloaded macOS binaries in install.sh before verification
- **Reasoning:** The installer was only stripping quarantine, so the broker verification step could be killed by Gatekeeper on macOS. Matching the SDK install path with an ad-hoc codesign makes broker verification succeed reliably.

---

## Chapters

### 1. Work
*Agent: default*

- Make src/cli/index.ts the sole executable CLI entrypoint and remove bootstrap auto-run: Make src/cli/index.ts the sole executable CLI entrypoint and remove bootstrap auto-run
- Re-sign downloaded macOS binaries in install.sh before verification: Re-sign downloaded macOS binaries in install.sh before verification
