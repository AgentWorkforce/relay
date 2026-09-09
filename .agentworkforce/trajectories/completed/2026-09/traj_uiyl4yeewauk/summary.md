# Trajectory: Diagnose Relay PR #1665 RelayFlow flush and macOS smoke blockers

> **Status:** ✅ Completed
> **Task:** relay#1665
> **Confidence:** 90%
> **Started:** September 9, 2026 at 07:48 AM
> **Completed:** September 9, 2026 at 08:00 AM

---

## Summary

Fixed candidate SHA provenance binding, removed invalid bundled absence-based proof, and isolated Cloud standalone flush recovery blocker as cloud#3465.

**Approach:** Standard approach

---

## Key Decisions

### Keep #1665 proof scoped to immutable Fleet snapshot behavior
- **Chose:** Keep #1665 proof scoped to immutable Fleet snapshot behavior
- **Reasoning:** The bundled #1682 helper treated missing head-only files as base bug evidence, violating the RelayFlow public-behavior contract and mixing case identities. Security qualification remains a separately tracked prerequisite.

### Bind candidate provenance to the validated candidate SHA
- **Chose:** Bind candidate provenance to the validated candidate SHA
- **Reasoning:** The trusted workflow checkout SHA identifies verifier code, while VERIFY_FLEET_EXPECTED_RELAY_SHA identifies the candidate attestation; conflating them makes release qualification fail before Fleet execution.

---

## Chapters

### 1. Work
*Agent: default*

- Keep #1665 proof scoped to immutable Fleet snapshot behavior: Keep #1665 proof scoped to immutable Fleet snapshot behavior
- Bind candidate provenance to the validated candidate SHA: Bind candidate provenance to the validated candidate SHA
- Relay #1665 has two independent infrastructure blockers: Cloud standalone TS flush bypass (cloud#3465) and transient Relaycast database overload; scoped Relay review defects are fixed locally and the full Node 22 suite is green.
