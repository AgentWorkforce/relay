# Trajectory: Add cloud logs redaction CLI flag

> **Status:** ✅ Completed
> **Task:** AR-305
> **Confidence:** 88%
> **Started:** June 18, 2026 at 08:21 PM
> **Completed:** June 18, 2026 at 08:28 PM

---

## Summary

Added agent-relay cloud logs --redact and SDK query propagation with CLI/SDK tests and changelog entry.

**Approach:** Standard approach

---

## Key Decisions

### Pass --redact through the cloud SDK instead of redacting locally

- **Chose:** Pass --redact through the cloud SDK instead of redacting locally
- **Reasoning:** Server-side redaction ensures content is scrubbed before the CLI writes stdout or JSON output and keeps redaction logic in Cloud's canonical Ricky module.

---

## Chapters

### 1. Work

_Agent: default_

- Pass --redact through the cloud SDK instead of redacting locally: Pass --redact through the cloud SDK instead of redacting locally
