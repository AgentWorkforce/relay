# Trajectory: Add semantic CLI attach support to the AI SDK harness adoption plan

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** July 15, 2026 at 07:19 PM
> **Completed:** July 15, 2026 at 07:21 PM

---

## Summary

Refined the AI SDK harness adoption plan with a broker-supervised semantic sidecar and first-class CLI attach contract.

**Approach:** Standard approach

---

## Key Decisions

### Use semantic attach for AI SDK runtimes

- **Chose:** Use semantic attach for AI SDK runtimes
- **Reasoning:** A separate CLI process cannot reach an in-process HarnessV1PromptControl. The broker must supervise a Node 22 sidecar, retain bounded normalized event history, broadcast live events, and acknowledge message-oriented input. Human attach renders those events; NDJSON is opt-in with --json.

---

## Chapters

### 1. Work

_Agent: default_

- Use semantic attach for AI SDK runtimes: Use semantic attach for AI SDK runtimes
