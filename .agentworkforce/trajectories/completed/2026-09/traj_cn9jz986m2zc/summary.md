# Trajectory: Continue PR #1665 repair from b309a10983; audit PR #1683 review threads and qualify trusted workflow

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 8, 2026 at 04:11 PM
> **Completed:** September 8, 2026 at 04:37 PM

---

## Summary

Repaired PR 1665 qualification workflow/test architecture, candidate isolation, bounded evidence handling, strict manifest/request/YAML validation, and explicit heavy-test budgets; verified Node 22 full suite, actionlint, typecheck, lint, format, and diff.

**Approach:** Standard approach

---

## Key Decisions

### Moved structural qualification assertions to the trusted workflow_run consumer and kept the dispatch bootstrap inert
- **Chose:** Moved structural qualification assertions to the trusted workflow_run consumer and kept the dispatch bootstrap inert
- **Reasoning:** The repository deliberately separates no-secret request dispatch from secret-bearing verification; tests must inspect the trusted consumer without weakening that boundary.

### Isolated candidate CLI inventory discovery in a secret-free child process and switched workspace lifecycle calls to the trusted CLI
- **Chose:** Isolated candidate CLI inventory discovery in a secret-free child process and switched workspace lifecycle calls to the trusted CLI
- **Reasoning:** Candidate bootstrap and workspace lifecycle code must not execute with verifier credentials.

### Raised only the identified heavy fixture test budgets to 20 seconds
- **Chose:** Raised only the identified heavy fixture test budgets to 20 seconds
- **Reasoning:** Each timeout reproduced as an isolated test completing under 5 seconds to 4.30 seconds, while full-suite scheduling exceeded Vitest's default 5-second test budget.

---

## Chapters

### 1. Work
*Agent: default*

- Moved structural qualification assertions to the trusted workflow_run consumer and kept the dispatch bootstrap inert: Moved structural qualification assertions to the trusted workflow_run consumer and kept the dispatch bootstrap inert
- Isolated candidate CLI inventory discovery in a secret-free child process and switched workspace lifecycle calls to the trusted CLI: Isolated candidate CLI inventory discovery in a secret-free child process and switched workspace lifecycle calls to the trusted CLI
- Raised only the identified heavy fixture test budgets to 20 seconds: Raised only the identified heavy fixture test budgets to 20 seconds
