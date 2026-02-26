# Trajectory: Rename broker-sdk package to sdk and remove sdk-ts

> **Status:** ✅ Completed
> **Confidence:** 74%
> **Started:** February 20, 2026 at 11:37 AM
> **Completed:** February 20, 2026 at 11:46 AM

---

## Summary

Renamed broker-sdk workspace/package to sdk, removed sdk-ts, updated exports/deps/imports/workflows/docs, and validated build+tsc with grep cleanup

**Approach:** Standard approach

---

## Key Decisions

### Renamed workspace package path and npm identity from broker-sdk to sdk

- **Chose:** Renamed workspace package path and npm identity from broker-sdk to sdk
- **Reasoning:** Align package directory, package name, root exports/dependencies, and cross-package imports while preserving root ./broker export compatibility.

### Updated postinstall and build scripts to target packages/sdk/bin for broker binary

- **Chose:** Updated postinstall and build scripts to target packages/sdk/bin for broker binary
- **Reasoning:** Prevents recreation of deleted packages/broker-sdk and keeps runtime binary install path aligned with renamed SDK package.

### Added missing Agent interface stubs in sdk unit test fake agent

- **Chose:** Added missing Agent interface stubs in sdk unit test fake agent
- **Reasoning:** Build failed due required Agent fields status/onOutput; stubbing in test restores type-correct build without runtime behavior changes.

---

## Chapters

### 1. Work

_Agent: default_

- Renamed workspace package path and npm identity from broker-sdk to sdk: Renamed workspace package path and npm identity from broker-sdk to sdk
- Updated postinstall and build scripts to target packages/sdk/bin for broker binary: Updated postinstall and build scripts to target packages/sdk/bin for broker binary
- Added missing Agent interface stubs in sdk unit test fake agent: Added missing Agent interface stubs in sdk unit test fake agent
