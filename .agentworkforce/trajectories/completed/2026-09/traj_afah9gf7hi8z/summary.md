# Trajectory: Stage exact broker binaries for Cloud RelayFlow Rust proofs

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** September 1, 2026 at 08:28 PM
> **Completed:** September 1, 2026 at 08:36 PM

---

## Summary

Added exact-SHA Linux broker build artifacts and a verified GitHub-to-Cloud handoff for Rust RelayFlow cases; 2260 tests, typecheck, actionlint, formatting, and lint validation pass.

**Approach:** Standard approach

---

## Key Decisions

### Use exact-SHA broker artifacts for Rust RelayFlow cases
- **Chose:** Use exact-SHA broker artifacts for Rust RelayFlow cases
- **Reasoning:** Daytona proof sandboxes lack Cargo and block toolchain downloads; GitHub can build static base/head brokers without Cloud credentials, while the trusted dispatcher verifies manifests and hashes and only executes them inside isolated Cloud sandboxes.

---

## Chapters

### 1. Work
*Agent: default*

- Use exact-SHA broker artifacts for Rust RelayFlow cases: Use exact-SHA broker artifacts for Rust RelayFlow cases
