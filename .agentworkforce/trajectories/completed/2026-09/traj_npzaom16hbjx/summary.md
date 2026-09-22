# Trajectory: Harden PR 1839 replay identity and document volatile dedupe boundary

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1837
> **Confidence:** 90%
> **Started:** September 22, 2026 at 02:37 AM
> **Completed:** September 22, 2026 at 02:38 AM

---

## Summary

PR 1839 now rejects conflicting delivery-ID replays, tests D1-to-D2 fail-closed behavior, and documents/tests the restart and eviction boundary for finn-mini and kjg-lap

**Approach:** Standard approach

---

## Key Decisions

### Fail closed when a seen message and sequence reappear under a different delivery ID
- **Chose:** Fail closed when a seen message and sequence reappear under a different delivery ID
- **Reasoning:** Recovery must require exact delivery identity; otherwise a D1-to-D2 replay can bypass custody and PTY completion fencing and reinject the message

### Scope dedupe guarantee to the live worker process and 512 completions
- **Chose:** Scope dedupe guarantee to the live worker process and 512 completions
- **Reasoning:** The PTY completion cache and broker receipt book are volatile bounded FIFOs; restart cannot safely claim recovery of existing held queues without durable evidence or live migration

---

## Chapters

### 1. Work
*Agent: default*

- Fail closed when a seen message and sequence reappear under a different delivery ID: Fail closed when a seen message and sequence reappear under a different delivery ID
- Scope dedupe guarantee to the live worker process and 512 completions: Scope dedupe guarantee to the live worker process and 512 completions
