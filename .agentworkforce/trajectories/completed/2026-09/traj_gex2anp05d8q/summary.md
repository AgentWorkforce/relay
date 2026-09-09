# Trajectory: Repair PR 1666 truthful set-model execution proof

> **Status:** ✅ Completed
> **Task:** relay#1666
> **Confidence:** 96%
> **Started:** September 9, 2026 at 06:13 AM
> **Completed:** September 9, 2026 at 06:44 AM

---

## Summary

Replaced PR 1666's split raw-broker/mock-CLI proof with a deterministic compiled CLI to real OpenCode lifecycle proof, including correlated applied/rejected receipts and release-owned session deletion.

**Approach:** Standard approach

---

## Key Decisions

### Use one exact compiled CLI path for spawn, model mutation, rejection, and release
- **Chose:** Use one exact compiled CLI path for spawn, model mutation, rejection, and release
- **Reasoning:** The old proof split raw-broker real-provider validation from a mock compiled-CLI receipt, so neither path proved the public command actually changed worker provider state.

### Run the proof against a deterministic local Relaycast transport
- **Chose:** Run the proof against a deterministic local Relaycast transport
- **Reasoning:** Production Relaycast returned workspace_storage_unavailable during a clean proof; Relaycast is transport setup, not the set-model behavior under test, and must not make this release proof flaky.

---

## Chapters

### 1. Work
*Agent: default*

- Use one exact compiled CLI path for spawn, model mutation, rejection, and release: Use one exact compiled CLI path for spawn, model mutation, rejection, and release
- Run the proof against a deterministic local Relaycast transport: Run the proof against a deterministic local Relaycast transport
- The truthful path now passes end to end with real OpenCode state; Node 22 full and focused suites plus broker model tests are green, and Veto reports no findings.
